// The slot writers the offline drain replays (#1638), behind one lazy module so
// the hook's dynamic import names this file, not `#/server/slots`.
export { claimSlot, reassignSlot, releaseSlot } from "#/server/slots";
