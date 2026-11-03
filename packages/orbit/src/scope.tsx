import { createContext, useContext, useState, type PropsWithChildren } from 'react';
import type { OrbitEnvironment } from './client';
const Context = createContext<ReturnType<typeof useStateValue> | null>(null);
function useStateValue() {
  const [organization, setOrganization] = useState('');
  const [application, setApplication] = useState('');
  const [environment, setEnvironment] = useState<OrbitEnvironment>('development');
  return {
    organization,
    setOrganization,
    application,
    setApplication,
    environment,
    setEnvironment,
  };
}
export function ScopeProvider({ children }: PropsWithChildren) {
  const value = useStateValue();
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useOrbitScope() {
  const value = useContext(Context);
  if (!value) throw Error('Orbit scope provider missing');
  return value;
}
