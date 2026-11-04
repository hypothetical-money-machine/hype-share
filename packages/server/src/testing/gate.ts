/** A promise and its opener, for holding an upload open at a chosen point. */
export function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Long enough for an injected request to reach its first await. */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));
