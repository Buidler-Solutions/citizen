import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { App } from '../App';

describe('wallet app', () => {
  it('creates a key and enables submission actions', async () => {
    const user = userEvent.setup();
    render(<App />);
    const createButton = screen.getByRole('button', { name: 'Create key' });
    await user.click(createButton);

    expect(screen.getByText(/Primary validator key/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit signed entry' })).toBeEnabled();
  });



  it('renders builder-issued asset disclosure parity notices', () => {
    render(<App />);
    expect(screen.getAllByText(/Builder-Issued Asset Disclosure/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/clawback_enabled: true/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Issuer clawback is ENABLED/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Issuer clawback is DISABLED/).length).toBeGreaterThan(0);
  });

  it('has no obvious accessibility violations', async () => {
    const { container } = render(<App />);
    const results = await axe(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    const severe = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(severe).toHaveLength(0);
  });
});
