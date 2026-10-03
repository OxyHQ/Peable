#!/usr/bin/env python3
"""Pinned ECS promotion. AWS boundaries are subprocesses, fixture-tested without AWS.

Task-definition configuration is preserved; only the named container image changes.
No secret values are read. Receipt files contain only ARNs, counts and image digests.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def aws(*args):
    try:
        result = subprocess.run(['aws', *args, '--output', 'json', '--cli-connect-timeout', '10', '--cli-read-timeout', '30'], capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        raise RuntimeError('AWS command deadline exceeded: ' + ' '.join(args[:2])) from None
    if result.returncode:
        # CLI errors can include request configuration and credentials. Retain
        # only the bounded AWS discriminator; local/validation errors are unknown.
        match = re.search(r'An error occurred \(([A-Za-z0-9._-]{1,80})\) when calling ', result.stderr)
        code = match.group(1) if match else 'unknown'
        raise RuntimeError('AWS command failed: ' + ' '.join(args[:2]) + ' code=' + code + ' exit=' + str(result.returncode))
    return json.loads(result.stdout)


def required(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError('Missing ' + name)
    return value


def check(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def image(value):
    repository = required('ECR_REGISTRY') + '/oxy/' + required('APP')
    check(re.fullmatch(re.escape(repository) + r'@sha256:[a-f0-9]{64}', value), 'Image must be a pinned app repository digest')
    return value


def service():
    data = aws('ecs', 'describe-services', '--cluster', required('CLUSTER'), '--services', required('APP'))
    check(not data.get('failures') and len(data.get('services', [])) == 1, 'Service lookup failed')
    return data['services'][0]


def running(svc, container):
    arns = aws('ecs', 'list-tasks', '--cluster', required('CLUSTER'), '--service-name', required('APP'), '--desired-status', 'RUNNING')['taskArns']
    if not arns:
        return []
    data = aws('ecs', 'describe-tasks', '--cluster', required('CLUSTER'), '--tasks', *arns)
    check(not data.get('failures'), 'Running task lookup failed')
    values = []
    for task in data['tasks']:
        matches = [c for c in task['containers'] if c['name'] == container]
        check(len(matches) == 1 and task['lastStatus'] == 'RUNNING', 'Missing or non-running app container')
        values.append((task['taskDefinitionArn'], matches[0].get('imageDigest')))
    return values


def definition_payload(response, container, pinned):
    td = dict(response['taskDefinition'])
    for field in ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities', 'registeredAt', 'registeredBy', 'deregisteredAt']:
        td.pop(field, None)
    td['containerDefinitions'] = [dict(c) for c in td['containerDefinitions']]
    matches = [c for c in td['containerDefinitions'] if c['name'] == container]
    check(len(matches) == 1, 'App container must be unique')
    matches[0]['image'] = image(pinned)
    # ECS rejects explicit [] (ClientException), although Describe returns it.
    if response.get('tags'):
        td['tags'] = response['tags']
    return td


def normalized(payload):
    # ECS supplies these documented defaults on readback; array order elsewhere
    # remains significant. Secret references are compared but never printed.
    result = json.loads(json.dumps(payload))
    result['tags'] = sorted(result.get('tags', []), key=lambda tag: (tag['key'], tag['value']))
    if result.get('enableFaultInjection') is False:
        result.pop('enableFaultInjection')
    for container in result['containerDefinitions']:
        if container.get('essential') is True:
            container.pop('essential')
        for field in ['environment', 'environmentFiles', 'mountPoints', 'volumesFrom', 'portMappings', 'systemControls']:
            if container.get(field) == []:
                container.pop(field)
    return result


def register(payload):
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as file:
        json.dump(payload, file); file.flush()
        registered = aws('ecs', 'register-task-definition', '--cli-input-json', 'file://' + file.name)
    arn = registered['taskDefinition']['taskDefinitionArn']
    path = Path(required('RELEASE_RECEIPT_DIR')) / 'registered.json'
    owned = json.loads(path.read_text()) if path.exists() else []
    owned.append(arn); receipt('registered', owned)  # Even a failed readback can be cleaned up.
    registered = aws('ecs', 'describe-task-definition', '--task-definition', arn, '--include', 'TAGS')
    expected_image = next(c['image'] for c in payload['containerDefinitions'] if c['name'] == required('APP'))
    actual_app = [c for c in registered['taskDefinition']['containerDefinitions'] if c['name'] == required('APP')]
    check(len(actual_app) == 1 and actual_app[0]['image'] == expected_image, 'Registered image differs from requested digest')
    returned = definition_payload(registered, required('APP'), expected_image)
    check(normalized(returned) == normalized(payload), 'Registered task definition changed configuration')
    return arn


def service_configuration(svc):
    fields = ['networkConfiguration', 'launchType', 'capacityProviderStrategy', 'platformVersion', 'loadBalancers', 'serviceRegistries', 'deploymentConfiguration', 'schedulingStrategy', 'enableExecuteCommand', 'enableECSManagedTags', 'propagateTags']
    selected = {field: svc.get(field) for field in fields}
    return hashlib.sha256(json.dumps(selected, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def receipt(name, data):
    target = Path(required('RELEASE_RECEIPT_DIR'))
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    (target / (name + '.json')).write_text(json.dumps(data, indent=2) + '\n')


def prepare():
    candidate = image(required('CANDIDATE_IMAGE'))
    svc = service(); check(svc['status'] == 'ACTIVE', 'Service is not active')
    check(len(svc['deployments']) == 1 and svc['deployments'][0]['rolloutState'] == 'COMPLETED', 'Service must be steady before preparation')
    current = svc['taskDefinition']; container = required('APP')
    response = aws('ecs', 'describe-task-definition', '--task-definition', current, '--include', 'TAGS')
    app = [c for c in response['taskDefinition']['containerDefinitions'] if c['name'] == container]
    check(len(app) == 1, 'App container must be unique')
    tasks = running(svc, container)
    if svc['desiredCount'] > 0:
        check(len(tasks) == svc['desiredCount'], 'Running capacity differs from desired capacity')
        check(all(td == current for td, _ in tasks), 'Mixed running task definitions')
        digests = {digest for _, digest in tasks}
        check(len(digests) == 1, 'Mixed running image digests')
        previous = image(required('ECR_REGISTRY') + '/oxy/' + required('APP') + '@' + next(iter(digests)))
    else:
        check(not tasks, 'Unexpected running tasks at zero capacity')
        previous = image(app[0]['image'])  # A mutable tag with zero tasks has no provable rollback image.
    rollback = register(definition_payload(response, container, previous))
    prepared = {'previousTaskDefinition': current, 'rollbackTaskDefinition': rollback, 'previousImage': previous, 'candidateImage': candidate, 'desiredCount': svc['desiredCount'], 'serviceConfiguration': service_configuration(svc)}
    receipt('prepared', prepared)  # Preserve rollback evidence even if candidate registration fails.
    candidate_td = register(definition_payload(response, container, candidate))
    prepared['candidateTaskDefinition'] = candidate_td; receipt('prepared', prepared)
    with open(required('GITHUB_OUTPUT'), 'a') as output:
        for key, value in {'status': 'ACTIVE', 'previous_task_definition': current, 'task_definition': candidate_td, 'rollback_task_definition': rollback, 'previous_image': previous, 'candidate_image': candidate, 'container': container, 'network': json.dumps(svc['networkConfiguration'], separators=(',', ':'))}.items():
            output.write(key + '=' + value + '\n')
    print('Prepared pinned candidate and rollback task definitions')


def verify_tasks(svc, td, expected):
    check(svc['taskDefinition'] == td, 'Service points to a different task definition')
    tasks = running(svc, required('APP'))
    check(len(tasks) == svc['desiredCount'], 'Running task count differs from desired count')
    check(all(revision == td and digest == expected.split('@')[1] for revision, digest in tasks), 'Running image/revision verification failed')


def wait_rollout(td, expected):
    deadline = time.monotonic() + int(os.environ.get('ROLLOUT_TIMEOUT_SECONDS', '1200'))
    while time.monotonic() < deadline:
        svc = service()
        primary = [d for d in svc['deployments'] if d['status'] == 'PRIMARY']
        if len(primary) == 1 and primary[0]['taskDefinition'] == td:
            check(primary[0]['rolloutState'] != 'FAILED', 'ECS rollout failed')
            if primary[0]['rolloutState'] == 'COMPLETED' and primary[0]['runningCount'] == svc['desiredCount'] and len(svc['deployments']) == 1:
                verify_tasks(svc, td, expected)
                receipt('running', {'taskDefinition': td, 'image': expected, 'runningCount': svc['desiredCount'], 'runtimeVerified': svc['desiredCount'] > 0})
                return
        time.sleep(float(os.environ.get('ROLLOUT_POLL_SECONDS', '15')))
    raise RuntimeError('ECS rollout deadline exceeded')


def rollout():
    td = required('TASK_DEFINITION'); candidate = image(required('CANDIDATE_IMAGE'))
    rollback = required('ROLLBACK_TASK_DEFINITION'); previous = image(required('PREVIOUS_IMAGE'))
    prepared = json.loads((Path(required('RELEASE_RECEIPT_DIR')) / 'prepared.json').read_text())
    check(td == prepared['candidateTaskDefinition'] and rollback == prepared['rollbackTaskDefinition'] and candidate == prepared['candidateImage'] and previous == prepared['previousImage'], 'Rollout inputs differ from preparation')
    svc = service()
    check(svc['taskDefinition'] == prepared['previousTaskDefinition'] and service_configuration(svc) == prepared['serviceConfiguration'], 'Service changed after preparation; no update attempted')
    check(len(svc['deployments']) == 1 and svc['deployments'][0]['rolloutState'] == 'COMPLETED', 'Service is no longer steady')
    verify_tasks(svc, prepared['previousTaskDefinition'], previous)
    try:
        receipt('rollout-started', {'taskDefinition': td})
        aws('ecs', 'update-service', '--cluster', required('CLUSTER'), '--service', required('APP'), '--task-definition', td, '--force-new-deployment')
        wait_rollout(td, candidate)
    except Exception:
        # ECS has no conditional update-service API. Recheck immediately before
        # mutation; external deployment tooling must also serialize this service.
        svc = service()
        allowed = {td, prepared['previousTaskDefinition']}
        check(svc['taskDefinition'] in allowed and all(d['taskDefinition'] in allowed for d in svc['deployments']) and service_configuration(svc) == prepared['serviceConfiguration'], 'External deployment/configuration detected; automatic rollback refused')
        receipt('rollback-attempt', {'taskDefinition': rollback, 'image': previous})
        aws('ecs', 'update-service', '--cluster', required('CLUSTER'), '--service', required('APP'), '--task-definition', rollback, '--force-new-deployment')
        wait_rollout(rollback, previous)
        receipt('rollback-completed', {'taskDefinition': rollback, 'image': previous})
        raise RuntimeError('Candidate rollout failed; pinned rollback verified')
    print('Pinned rollout verified (zero capacity explicitly recorded without runtime claim)')


def cleanup():
    directory = Path(required('RELEASE_RECEIPT_DIR'))
    if not (directory / 'registered.json').exists():
        return
    owned = json.loads((directory / 'registered.json').read_text())
    prepared = json.loads((directory / 'prepared.json').read_text()) if (directory / 'prepared.json').exists() else {}
    # Preserve the known pinned rollback after any rollout attempt. Before a
    # rollout, both unused copies can be discarded. Never remove live references.
    retained = {prepared.get('rollbackTaskDefinition')} if (directory / 'rollout-started.json').exists() else set()
    outcomes = []
    for arn in owned:
        svc = service()
        referenced = {svc['taskDefinition'], *(d['taskDefinition'] for d in svc['deployments'])}
        tasks = set()
        # RUNNING desired status includes pending tasks; STOPPED includes tasks
        # still draining. Inspect lastStatus so neither loses its definition.
        for desired in ['RUNNING', 'STOPPED']:
            tasks.update(aws('ecs', 'list-tasks', '--cluster', required('CLUSTER'), '--family', required('TASK_FAMILY'), '--desired-status', desired)['taskArns'])
        tasks = sorted(tasks)
        if tasks:
            for offset in range(0, len(tasks), 100):
                data = aws('ecs', 'describe-tasks', '--cluster', required('CLUSTER'), '--tasks', *tasks[offset:offset + 100])
                check(not data.get('failures'), 'Cleanup task lookup failed')
                referenced.update(task['taskDefinitionArn'] for task in data['tasks'] if task['lastStatus'] != 'STOPPED')
        if arn in retained or arn in referenced:
            outcomes.append({'taskDefinition': arn, 'action': 'retained'})
        else:
            result = aws('ecs', 'deregister-task-definition', '--task-definition', arn)
            check(result['taskDefinition']['status'] == 'INACTIVE', 'Task definition cleanup was not confirmed')
            outcomes.append({'taskDefinition': arn, 'action': 'deregistered'})
        receipt('cleanup', outcomes)



try:
    {'prepare': prepare, 'rollout': rollout, 'cleanup': cleanup}[sys.argv[1]]()
except Exception as error:
    # Deliberately omit AWS payloads/configuration and stack locals from Actions logs.
    print('::error::' + (str(error) if isinstance(error, RuntimeError) else 'Pinned release preparation or verification failed'), file=sys.stderr)
    sys.exit(1)
