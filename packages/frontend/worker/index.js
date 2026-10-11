const assetWorker = {
  fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};

export default {
  fetch(request, env, ctx) {
    return assetWorker.fetch(request, env, ctx);
  },
};
