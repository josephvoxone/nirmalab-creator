import { fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MentionTextarea, type MentionItem, type MentionTriggers } from './MentionTextarea.js';

const PEOPLE: MentionItem[] = [
  { id: 'LARAS', label: 'Laras', hint: 'LARAS', avatar: '/api/stories/x/cast/LARAS/image?w=160', insert: 'LARAS' },
  { id: 'BIMA', label: 'Bima', hint: 'BIMA', insert: 'BIMA' },
  { id: 'BU_SARI', label: 'Bu Sari', insert: 'BU_SARI' }
];
const PLACES: MentionItem[] = [{ id: 'PAGAR', label: 'Pagar rumah', insert: 'PAGAR' }];
const SHOTS: MentionItem[] = Array.from({ length: 12 }, (_, i) => ({ id: `s${i + 1}`, label: `Shot ${i + 1}`, insert: `shot ${i + 1}` }));
const TRIGGERS: MentionTriggers = { '@': PEOPLE, '#': PLACES, '/': SHOTS };

function Harness(props: { onSubmit?: (v: string) => void; initial?: string }) {
  const [value, setValue] = useState(props.initial ?? '');
  return (
    <>
      <MentionTextarea ariaLabel="Arahan" placeholder="mis. buka dengan @LARAS" value={value} onChange={setValue} triggers={TRIGGERS} onSubmit={props.onSubmit} rows={1} maxRows={6} />
      <output data-testid="value">{value}</output>
    </>
  );
}

const box = () => screen.getByRole('combobox', { name: 'Arahan' });

describe('MentionTextarea', () => {
  it('typing "@La" lists Laras; Enter inserts "LARAS " in place of the trigger', async () => {
    render(<Harness />);
    await userEvent.type(box(), 'buka dengan @La');
    const list = screen.getByRole('listbox');
    expect(within(list).getAllByRole('option').map(o => o.textContent)).toEqual([expect.stringContaining('Laras')]);
    expect(box()).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{Enter}');
    expect(box()).toHaveValue('buka dengan LARAS ');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box()).toHaveAttribute('aria-expanded', 'false');
  });

  it('matches the insert text too, case-insensitively, and shows at most 8 items', async () => {
    render(<Harness />);
    await userEvent.type(box(), '@bu_');
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map(o => o.textContent)).toEqual([expect.stringContaining('Bu Sari')]);
    await userEvent.clear(box());
    await userEvent.type(box(), '/');
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(8);
  });

  it('wires role=combobox to the listbox with aria-controls and aria-activedescendant; arrows move the active option', async () => {
    render(<Harness />);
    expect(box()).toHaveAttribute('aria-expanded', 'false');
    await userEvent.type(box(), '@');
    const list = screen.getByRole('listbox');
    expect(box()).toHaveAttribute('aria-controls', list.id);
    const options = within(list).getAllByRole('option');
    expect(box()).toHaveAttribute('aria-activedescendant', options[0]!.id);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowDown}');
    expect(box()).toHaveAttribute('aria-activedescendant', options[1]!.id);
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(box()).toHaveAttribute('aria-activedescendant', options[2]!.id);
    await userEvent.keyboard('{Tab}');
    expect(box()).toHaveValue('BU_SARI ');
  });

  it('shows a bounded 20 px avatar or initials', async () => {
    render(<Harness />);
    await userEvent.type(box(), '@');
    const [laras, bima] = within(screen.getByRole('listbox')).getAllByRole('option');
    const img = laras!.querySelector('img')!;
    expect(img).toHaveAttribute('width', '20');
    expect(img).toHaveAttribute('height', '20');
    expect(img.getAttribute('src')).toContain('w=160');
    expect(bima!.querySelector('img')).toBeNull();
    expect(bima).toHaveTextContent('BI');
  });

  it('Escape closes the list without clearing the text', async () => {
    render(<Harness />);
    await userEvent.type(box(), 'di #Pa');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box()).toHaveValue('di #Pa');
  });

  it('Enter submits only while the list is closed; Shift+Enter is a new line', async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    await userEvent.type(box(), 'pakai @Bi');
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(box()).toHaveValue('pakai BIMA ');
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('pakai BIMA \n');
  });

  it('a mouse click on an option inserts it', async () => {
    render(<Harness initial="mulai " />);
    await userEvent.type(box(), '#');
    await userEvent.click(screen.getByRole('option', { name: /pagar rumah/i }));
    expect(box()).toHaveValue('mulai PAGAR ');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('a trigger inside a word does not open the list; no match closes it', async () => {
    render(<Harness />);
    await userEvent.type(box(), 'email@La');
    expect(screen.queryByRole('listbox')).toBeNull();
    await userEvent.clear(box());
    await userEvent.type(box(), '@zzz');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('grows with its content between rows and maxRows', () => {
    render(<Harness />);
    const el = box() as HTMLTextAreaElement;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 400 });
    fireEvent.change(el, { target: { value: 'a\nb\nc\nd\ne\nf\ng\nh\ni' } });
    // 6 rows × 20 px line height + padding cap; never the full 400 px.
    expect(parseFloat(el.style.height)).toBeLessThan(400);
    expect(parseFloat(el.style.height)).toBeGreaterThan(20);
  });
});
