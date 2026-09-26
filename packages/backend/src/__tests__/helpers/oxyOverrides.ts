import type { oxy as OxyInstance } from "../../oxy";

type Oxy = typeof OxyInstance;
type Overrides = { [K in keyof Oxy]?: Partial<Record<keyof Oxy[K], unknown>> };

/**
 * The real `oxy` client with a few namespace methods replaced. Everything else
 * (`middleware`, other namespaces, other methods) forwards to the real
 * instance, bound to it so private state stays intact — `mock.module` is
 * process-wide in bun, and other test files keep using the real middleware.
 */
export function overrideOxy(real: Oxy, overrides: Overrides): Oxy {
  const bindTo = (target: object, value: unknown) =>
    typeof value === "function" ? value.bind(target) : value;
  return new Proxy(real, {
    get(target, prop) {
      const replaced = overrides[prop as keyof Oxy] as Record<PropertyKey, unknown> | undefined;
      const value = Reflect.get(target, prop, target);
      if (!replaced) return bindTo(target, value);
      const ns = value as object;
      return new Proxy(ns, {
        get(nsTarget, nsProp) {
          if (nsProp in replaced) return replaced[nsProp];
          return bindTo(nsTarget, Reflect.get(nsTarget, nsProp, nsTarget));
        },
      });
    },
  });
}
