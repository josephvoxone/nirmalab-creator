/**
 * A viewer reads a project: the write affordances are not rendered at all (not merely disabled
 * or hidden with CSS), and the server still answers 403 VIEWER_READ_ONLY to anything that tries.
 */
import { createContext, useContext, type ReactNode } from 'react';

const ReadOnlyContext = createContext(false);

export function ReadOnlyProvider(props: { value: boolean; children: ReactNode }) {
  return <ReadOnlyContext.Provider value={props.value}>{props.children}</ReadOnlyContext.Provider>;
}

export const useReadOnly = () => useContext(ReadOnlyContext);
