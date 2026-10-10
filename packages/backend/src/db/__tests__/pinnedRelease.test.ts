import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dir, '../../../../..');
const repository = 'registry.example/oxy/peable';
const oldDigest = `sha256:${'a'.repeat(64)}`;
const nextDigest = `sha256:${'b'.repeat(64)}`;
// Executed AWS CLI boundary, not mocks of the release's decision functions.
const fakeAws = `#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
p=Path(os.environ['FAKE_STATE']);s=json.loads(p.read_text());a=sys.argv[1:];op=a[1]
def arg(n):return a[a.index(n)+1]
def emit(v):
 p.write_text(json.dumps(s));print(json.dumps(v));sys.exit(0)
s['calls'].append(op)
if op=='describe-services':emit({'services':[s['service']]})
if op=='list-tasks':emit({'taskArns':[v['taskArn'] for v in s['tasks']]})
if op=='describe-tasks':emit({'tasks':s['tasks']})
if op=='describe-task-definition':emit(s['definitions'][arg('--task-definition')])
if op=='deregister-task-definition':
 s['definitions'][arg('--task-definition')]['taskDefinition']['status']='INACTIVE';emit(s['definitions'][arg('--task-definition')])
if op=='register-task-definition':
 payload=json.loads(Path(arg('--cli-input-json')[7:]).read_text())
 if payload.get('tags')==[]:
  p.write_text(json.dumps(s));print('An error occurred (ClientException) when calling the RegisterTaskDefinition operation: Tags can not be empty.',file=sys.stderr);sys.exit(254)
 if s['scenario'] in ['aws-error','local-error']:
  p.write_text(json.dumps(s));prefix='An error occurred (AccessDeniedException) when calling the RegisterTaskDefinition operation: ' if s['scenario']=='aws-error' else 'Parameter validation failed: '
  print(prefix+'SECRET_CANARY token=https://private.invalid/?token=DO_NOT_PRINT',file=sys.stderr);sys.exit(252)
 arn='arn:td:'+str(len(s['definitions'])+1)
 if s['scenario']=='tamper':payload['containerDefinitions'][0]['environment'].append({'name':'UNREQUESTED','value':'bad'})
 result={'taskDefinition':dict(payload,taskDefinitionArn=arn,revision=len(s['definitions'])+1,status='ACTIVE'),'tags':payload.pop('tags',[])}
 result['taskDefinition'].pop('tags',None);s['definitions'][arn]=result;emit(result)
if op=='update-service':
 td=arg('--task-definition');c=s['definitions'][td]['taskDefinition']['containerDefinitions'][0];s['service']['taskDefinition']=td
 candidate=c['image'].endswith('b'*64);failed=candidate and s['scenario']=='rollout-failure'
 s['service']['deployments']=[{'status':'PRIMARY','taskDefinition':td,'rolloutState':'FAILED' if failed else 'COMPLETED','runningCount':s['service']['desiredCount']}]
 for t in s['tasks']:
  t['taskDefinitionArn']=td;t['containers'][0]['imageDigest']=('sha256:'+'c'*64) if candidate and s['scenario']=='wrong-running-digest' else c['image'].split('@')[1]
 if candidate and s['scenario']=='external-during-rollout':
  s['service']['taskDefinition']='arn:td:external';s['service']['deployments'][0]['taskDefinition']='arn:td:external'
 emit({'service':s['service']})
raise Exception('Unexpected fake command')
`;
function fixture(scenario = 'success', zero = false) {
  const directory = mkdtempSync(join(tmpdir(), 'peable-pinned-release-'));
  const statePath = join(directory, 'state.json');
  const output = join(directory, 'outputs');
  const app = {
    name: 'peable',
    image: zero ? `${repository}@${oldDigest}` : `${repository}:latest`,
    environment: [{ name: 'ORDINARY_CONFIG', value: 'preserved' }],
    secrets: [{ name: 'DATABASE_URL', valueFrom: 'arn:ssm:existing' }],
    portMappings: [{ containerPort: 3001 }],
  };
  const td = {
    family: 'oxy-peable',
    taskDefinitionArn: 'arn:td:old',
    revision: 5,
    status: 'ACTIVE',
    taskRoleArn: 'arn:role:task',
    executionRoleArn: 'arn:role:execution',
    containerDefinitions: [app],
    networkMode: 'awsvpc',
    cpu: '256',
    memory: '512',
  };
  const task = {
    taskArn: 'arn:task:one',
    taskDefinitionArn: 'arn:td:old',
    lastStatus: 'RUNNING',
    containers: [{ name: 'peable', imageDigest: oldDigest }],
  };
  const tasks = zero ? [] : [task];
  if (scenario === 'mixed-digest')
    tasks.push({
      ...task,
      taskArn: 'arn:task:two',
      containers: [{ name: 'peable', imageDigest: nextDigest }],
    });
  if (scenario === 'mixed-revision')
    tasks.push({ ...task, taskArn: 'arn:task:two', taskDefinitionArn: 'arn:td:other' });
  const service = {
    status: 'ACTIVE',
    taskDefinition: 'arn:td:old',
    desiredCount: tasks.length,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: ['subnet-own'],
        securityGroups: ['sg-own'],
        assignPublicIp: 'DISABLED',
      },
    },
    deployments: [
      {
        status: 'PRIMARY',
        taskDefinition: 'arn:td:old',
        rolloutState: 'COMPLETED',
        runningCount: tasks.length,
      },
    ],
  };
  writeFileSync(
    statePath,
    JSON.stringify({
      scenario,
      service,
      tasks,
      definitions: {
        'arn:td:old': {
          taskDefinition: td,
          tags: scenario === 'empty-tags' ? [] : [{ key: 'app', value: 'peable' }],
        },
      },
      calls: [],
    }),
  );
  writeFileSync(join(directory, 'aws'), fakeAws);
  chmodSync(join(directory, 'aws'), 0o700);
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    FAKE_STATE: statePath,
    APP: 'peable',
    CLUSTER: 'synthetic-cluster',
    TASK_FAMILY: 'oxy-peable',
    ECR_REGISTRY: 'registry.example',
    CANDIDATE_IMAGE: `${repository}@${nextDigest}`,
    GITHUB_OUTPUT: output,
    RELEASE_RECEIPT_DIR: join(directory, 'receipts'),
    ROLLOUT_TIMEOUT_SECONDS: '2',
    ROLLOUT_POLL_SECONDS: '0.01',
  };
  return {
    directory,
    env,
    setState: (state: unknown) => writeFileSync(statePath, JSON.stringify(state)),
    state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    run: (action: string, extra: Record<string, string> = {}) =>
      Bun.spawnSync(['python3', '.github/scripts/ecs-release.py', action], {
        cwd: ROOT,
        env: { ...env, ...extra },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    outputs: () =>
      Object.fromEntries(
        readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .map((line) => {
            const at = line.indexOf('=');
            return [line.slice(0, at), line.slice(at + 1)];
          }),
      ),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}
function rolloutEnv(outputs: Record<string, string>) {
  return {
    TASK_DEFINITION: outputs.task_definition!,
    ROLLBACK_TASK_DEFINITION: outputs.rollback_task_definition!,
    PREVIOUS_IMAGE: outputs.previous_image!,
  };
}
describe('pinned ECS release', () => {
  test('restricts manual and push promotion to main, exact CI, with post and cleanup still reachable', () => {
    const workflow = Bun.YAML.parse(
      readFileSync(join(ROOT, '.github/workflows/deploy-aws.yml'), 'utf8'),
    ) as {
      on: { workflow_dispatch: { inputs: { sync_secrets: { default: boolean } } } };
      jobs: Record<string, { if: string; steps: { name?: string; if?: string; run?: string }[] }>;
    };
    expect(workflow.jobs.gate!.if).toBe("github.ref == 'refs/heads/main'");
    expect(workflow.jobs.deploy!.if).toBe("github.ref == 'refs/heads/main'");
    const gate = workflow.jobs.gate!.steps[0]!.run!;
    expect(gate).toContain('head_sha=$SHA');
    expect(gate).not.toContain('EVENT');
    const steps = workflow.jobs.deploy!.steps;
    expect(workflow.on.workflow_dispatch.inputs.sync_secrets.default).toBe(false);
    expect(steps.find((step) => step.name?.startsWith('Sync GitHub secrets'))?.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.sync_secrets == true",
    );
    expect(steps.find((step) => step.name?.includes('Clean up unused'))?.if).toBe('always()');
    expect(steps.find((step) => step.name?.startsWith('Migrate (post)'))?.if).not.toContain(
      'desiredCount',
    );
  });
  test('omits empty tags from the actual untagged deployment shape', () => {
    const f = fixture('empty-tags');
    try {
      expect(f.run('prepare').exitCode).toBe(0);
      expect(
        f.state().calls.filter((op: string) => op === 'register-task-definition'),
      ).toHaveLength(2);
      expect(f.run('cleanup').exitCode).toBe(0);
    } finally {
      f.remove();
    }
  });
  for (const scenario of ['aws-error', 'local-error']) {
    test(`reports only safe error code and CLI exit for ${scenario}`, () => {
      const f = fixture(scenario);
      try {
        const result = f.run('prepare');
        expect(result.exitCode).toBe(1);
        const output = result.stdout.toString() + result.stderr.toString();
        expect(output).toContain(
          scenario === 'aws-error' ? 'code=AccessDeniedException' : 'code=unknown',
        );
        expect(output).toContain('exit=252');
        for (const forbidden of ['SECRET_CANARY', 'private.invalid', 'DO_NOT_PRINT', 'token='])
          expect(output).not.toContain(forbidden);
        expect(
          f.state().calls.filter((op: string) => op === 'register-task-definition'),
        ).toHaveLength(1);
        expect(f.run('cleanup').exitCode).toBe(0);
        expect(f.state().calls).not.toContain('deregister-task-definition');
      } finally {
        f.remove();
      }
    });
  }
  test('copies configuration, pins both revisions, then verifies the running candidate', () => {
    const f = fixture();
    try {
      expect(f.run('prepare').exitCode).toBe(0);
      const out = f.outputs();
      const state = f.state();
      const original = state.definitions['arn:td:old'].taskDefinition;
      for (const arn of [out.task_definition, out.rollback_task_definition]) {
        const copied = state.definitions[arn!].taskDefinition;
        expect(state.definitions[arn!].tags).toEqual([{ key: 'app', value: 'peable' }]);
        expect(copied.executionRoleArn).toBe(original.executionRoleArn);
        expect(copied.taskRoleArn).toBe(original.taskRoleArn);
        expect(copied.containerDefinitions[0].secrets).toEqual(
          original.containerDefinitions[0].secrets,
        );
        expect(copied.containerDefinitions[0].environment).toEqual(
          original.containerDefinitions[0].environment,
        );
      }
      expect(
        state.definitions[out.rollback_task_definition!].taskDefinition.containerDefinitions[0]
          .image,
      ).toBe(`${repository}@${oldDigest}`);
      expect(f.run('rollout', rolloutEnv(out)).exitCode).toBe(0);
      expect(f.state().service.taskDefinition).toBe(out.task_definition);
      expect(
        JSON.parse(readFileSync(join(f.directory, 'receipts/running.json'), 'utf8'))
          .runtimeVerified,
      ).toBe(true);
    } finally {
      f.remove();
    }
  });
  for (const scenario of ['mixed-digest', 'mixed-revision', 'tamper']) {
    test(`refuses ${scenario} during prepare`, () => {
      const f = fixture(scenario);
      try {
        expect(f.run('prepare').exitCode).toBe(1);
        expect(f.state().calls).not.toContain('update-service');
        if (scenario !== 'tamper')
          expect(f.state().calls).not.toContain('register-task-definition');
      } finally {
        f.remove();
      }
    });
  }
  for (const scenario of ['rollout-failure', 'wrong-running-digest']) {
    test(`rolls back to the actual previous digest after ${scenario}`, () => {
      const f = fixture(scenario);
      try {
        expect(f.run('prepare').exitCode).toBe(0);
        const out = f.outputs();
        expect(f.run('rollout', rolloutEnv(out)).exitCode).toBe(1);
        expect(f.state().service.taskDefinition).toBe(out.rollback_task_definition);
        expect(f.state().tasks[0].containers[0].imageDigest).toBe(oldDigest);
        expect(existsSync(join(f.directory, 'receipts/rollback-completed.json'))).toBe(true);
      } finally {
        f.remove();
      }
    });
  }
  test('refuses a changed revision or configuration after pre-migration without overwriting it', () => {
    for (const change of ['revision', 'configuration']) {
      const f = fixture();
      try {
        expect(f.run('prepare').exitCode).toBe(0);
        const state = f.state();
        if (change === 'revision') state.service.taskDefinition = 'arn:td:external';
        else state.service.networkConfiguration.awsvpcConfiguration.subnets = ['subnet-external'];
        f.setState(state);
        expect(f.run('rollout', rolloutEnv(f.outputs())).exitCode).toBe(1);
        expect(f.state().calls).not.toContain('update-service');
      } finally {
        f.remove();
      }
    }
  });
  test('does not roll back over an external deployment arriving during rollout', () => {
    const f = fixture('external-during-rollout');
    try {
      expect(f.run('prepare').exitCode).toBe(0);
      expect(f.run('rollout', rolloutEnv(f.outputs())).exitCode).toBe(1);
      expect(f.state().service.taskDefinition).toBe('arn:td:external');
      expect(f.state().calls.filter((call: string) => call === 'update-service')).toHaveLength(1);
    } finally {
      f.remove();
    }
  });
  test('cleans unused copies after pre failure, including failed readback registration', () => {
    for (const scenario of ['success', 'tamper']) {
      const f = fixture(scenario);
      try {
        expect(f.run('prepare').exitCode).toBe(scenario === 'success' ? 0 : 1);
        expect(f.run('cleanup').exitCode).toBe(0);
        const state = f.state();
        expect(state.definitions['arn:td:old'].taskDefinition.status).toBe('ACTIVE');
        for (const [arn, value] of Object.entries(state.definitions)) {
          if (arn !== 'arn:td:old')
            expect((value as { taskDefinition: { status: string } }).taskDefinition.status).toBe(
              'INACTIVE',
            );
        }
      } finally {
        f.remove();
      }
    }
  });
  test('retains serving and rollback definitions after promotion', () => {
    const f = fixture();
    try {
      expect(f.run('prepare').exitCode).toBe(0);
      const out = f.outputs();
      expect(f.run('rollout', rolloutEnv(out)).exitCode).toBe(0);
      expect(f.run('cleanup').exitCode).toBe(0);
      expect(f.state().calls).not.toContain('deregister-task-definition');
    } finally {
      f.remove();
    }
  });
  test('retains an unused candidate while a running task still references it', () => {
    const f = fixture();
    try {
      expect(f.run('prepare').exitCode).toBe(0);
      const out = f.outputs();
      const state = f.state();
      state.tasks.push({
        ...state.tasks[0],
        taskArn: 'arn:own:migrator',
        taskDefinitionArn: out.task_definition,
      });
      f.setState(state);
      expect(f.run('cleanup').exitCode).toBe(0);
      expect(f.state().definitions[out.task_definition!].taskDefinition.status).toBe('ACTIVE');
      expect(f.state().definitions[out.rollback_task_definition!].taskDefinition.status).toBe(
        'INACTIVE',
      );
    } finally {
      f.remove();
    }
  });
  test('zero capacity repoints a known pinned revision without a runtime claim', () => {
    const f = fixture('success', true);
    try {
      expect(f.run('prepare').exitCode).toBe(0);
      const out = f.outputs();
      expect(f.run('rollout', rolloutEnv(out)).exitCode).toBe(0);
      expect(
        JSON.parse(readFileSync(join(f.directory, 'receipts/running.json'), 'utf8'))
          .runtimeVerified,
      ).toBe(false);
    } finally {
      f.remove();
    }
  });

  for (const scenario of [
    'success',
    'wrong-digest',
    'failed-migration',
    'wait-timeout',
    'foreign-task',
    'foreign-run',
  ]) {
    test(`candidate migrator validates both image and exit: ${scenario}`, () => {
      const directory = mkdtempSync(join(tmpdir(), 'peable-migration-pin-'));
      try {
        const script = `#!/usr/bin/env bash
case "$2" in
run-task) echo "$*" > '${directory}/launched'; echo arn:own-migration ;;
wait) if [ '${scenario}' = wait-timeout ] || [ '${scenario}' = foreign-task ] || [ '${scenario}' = foreign-run ]; then [ -f '${directory}/stopped' ]; else exit 0; fi ;;
stop-task) echo "$*" > '${directory}/stopped' ;;

describe-tasks)
case "$*" in
*imageDigest*) echo '${scenario === 'wrong-digest' ? oldDigest : nextDigest}' ;;
*exitCode*) echo '${scenario === 'failed-migration' ? '1' : '0'}' ;;
*stoppedReason*) echo EssentialContainerExited ;;
*lastStatus*) echo STOPPED ;;
*) echo '{"tasks":[{"taskArn":"arn:own-migration","taskDefinitionArn":"${scenario === 'foreign-task' ? 'arn:td:foreign' : 'arn:td:candidate'}","startedBy":"peable-123-1-pre","lastStatus":"RUNNING","tags":[{"key":"OxyOperation","value":"PeableMigration"},{"key":"OxyTaskFamily","value":"oxy-peable"},{"key":"OxyRunId","value":"${scenario === 'foreign-run' ? '456-2' : '123-1'}"}]}]}' ;;
esac ;;
esac
`;
        writeFileSync(join(directory, 'aws'), script);
        chmodSync(join(directory, 'aws'), 0o700);
        const result = Bun.spawnSync(['bash', '.github/scripts/run-migration-task.sh', 'pre'], {
          cwd: ROOT,
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            CLUSTER: 'synthetic',
            APP: 'peable',
            PG_DATABASE: 'synthetic_owned',
            RELEASE_RUN_ID: '123-1',
            TASK_DEFINITION: 'arn:td:candidate',
            CONTAINER_NAME: 'peable',
            NETWORK_CONFIGURATION: '{}',
            EXPECTED_IMAGE: `${repository}@${nextDigest}`,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(result.exitCode).toBe(scenario === 'success' ? 0 : 1);
        if (scenario === 'wait-timeout') {
          expect(readFileSync(join(directory, 'stopped'), 'utf8')).toContain(
            '--task arn:own-migration',
          );
          expect(result.stdout.toString()).toContain('cleanup confirmed STOPPED');
        }
        expect(readFileSync(join(directory, 'launched'), 'utf8')).toContain('PeableMigration');
        expect(readFileSync(join(directory, 'launched'), 'utf8')).toContain('peable-123-1-pre');
        if (scenario === 'foreign-task' || scenario === 'foreign-run')
          expect(existsSync(join(directory, 'stopped'))).toBe(false);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
