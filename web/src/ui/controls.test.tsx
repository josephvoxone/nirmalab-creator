import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Choice, DateTimePicker, Segmented, Steps } from './controls.js';

describe('Choice (Solid Glass select, not native)', () => {
  it('shows the current option and picks another', async () => {
    const onChange = vi.fn();
    function Host() {
      const [v, setV] = useState('8');
      return <Choice label="Jumlah shot" value={v} onChange={x => { setV(x); onChange(x); }} options={[{ value: '6', label: '6 shot' }, { value: '8', label: '8 shot' }]} />;
    }
    render(<Host />);
    const trigger = screen.getByRole('combobox', { name: 'Jumlah shot' });
    expect(trigger).toHaveTextContent('8 shot');
    expect(document.querySelector('select')).toBeNull();
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('option', { name: '6 shot' }));
    expect(onChange).toHaveBeenCalledWith('6');
    expect(screen.getByRole('combobox', { name: 'Jumlah shot' })).toHaveTextContent('6 shot');
  });
});

describe('Segmented', () => {
  it('is a radiogroup with the chosen one checked', async () => {
    const onChange = vi.fn();
    render(<Segmented name="Rasio" value="9:16" onChange={onChange} options={[{ value: '9:16', label: '9:16' }, { value: '16:9', label: '16:9' }]} />);
    expect(screen.getByRole('radio', { name: '9:16' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByRole('radio', { name: '16:9' }));
    expect(onChange).toHaveBeenCalledWith('16:9');
  });
});

describe('DateTimePicker (popover calendar)', () => {
  it('opens a calendar popover, picks a day and a time', async () => {
    const onChange = vi.fn();
    const now = new Date(2026, 9, 24, 10, 0);
    render(<DateTimePicker label="Jadwal tayang" value={undefined} onChange={onChange} now={now} />);
    const trigger = screen.getByRole('button', { name: /jadwal tayang/i });
    expect(trigger).toHaveTextContent(/pilih tanggal/i);
    expect(document.querySelector('input[type="date"],input[type="datetime-local"]')).toBeNull();
    await userEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /\b28 Oktober 2026/ }));
    expect(onChange).toHaveBeenLastCalledWith(new Date(2026, 9, 28, 19, 0));
    await userEvent.click(within(dialog).getByRole('combobox', { name: /jam/i }));
    await userEvent.click(await screen.findByRole('option', { name: '08:30' }));
    expect(onChange).toHaveBeenLastCalledWith(new Date(2026, 9, 28, 8, 30));
  });

  it('refuses days in the past', async () => {
    const now = new Date(2026, 9, 24, 10, 0);
    render(<DateTimePicker label="Jadwal" value={undefined} onChange={() => undefined} now={now} />);
    await userEvent.click(screen.getByRole('button', { name: /jadwal/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /\b20 Oktober 2026/ })).toBeDisabled();
  });
});

describe('Steps', () => {
  it('marks the current step and lets you go back to a finished one only', async () => {
    const onStep = vi.fn();
    render(<Steps label="Langkah" current={1} onStep={onStep} steps={['Jenis', 'Gaya', 'Prompt']} />);
    const list = screen.getByRole('list', { name: 'Langkah' });
    expect(within(list).getByRole('button', { name: /gaya/i })).toHaveAttribute('aria-current', 'step');
    await userEvent.click(within(list).getByRole('button', { name: /jenis/i }));
    expect(onStep).toHaveBeenCalledWith(0);
    expect(within(list).getByRole('button', { name: /prompt/i })).toBeDisabled();
  });
});
