import { afterEach, expect, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { MerchantIdentity } from '../MerchantIdentity';

afterEach(() => {
  cleanup();
});

test('shows the wordmark in place of the name, keeping the name as its text', () => {
  render(
    <MerchantIdentity
      merchant={{
        name: 'Acme',
        avatar_url: null,
        logo_url: 'https://cdn.example/logo.png',
        description: null,
      }}
    />,
  );
  const logo = screen.getByRole('img', { name: 'Acme' }) as HTMLImageElement;
  expect(logo.src).toBe('https://cdn.example/logo.png');
});

test('shows the name when there is no logo', () => {
  render(
    <MerchantIdentity
      merchant={{ name: 'Acme', avatar_url: null, logo_url: null, description: null }}
    />,
  );
  expect(screen.getByText('Acme')).toBeDefined();
});
