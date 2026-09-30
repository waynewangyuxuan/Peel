export const STEP_FOLD_THRESHOLD = 5;

const CONVERSATION = new Set(["userMessage", "agentMessage", "error"]);

export function isFoldableStep(type: string): boolean {
  return !CONVERSATION.has(type);
}

export function stepCount(types: string[]): number {
  return types.filter(isFoldableStep).length;
}

export function canFoldSteps(types: string[]): boolean {
  return stepCount(types) > STEP_FOLD_THRESHOLD;
}
