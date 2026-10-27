export async function finishSetup(finish: () => Promise<boolean>, onDone: (notifications: boolean) => void, notifications: boolean): Promise<void> {
  if (await finish()) onDone(notifications);
}

export function openSetupWhenReady(requested: boolean, loaded: boolean, open: () => void): boolean {
  if (!requested || !loaded) return false;
  open();
  return true;
}
