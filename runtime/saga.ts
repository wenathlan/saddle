/**
 * saga executes compensations in reverse order when a multi step operation fails.
 */
export async function saga(steps, context = {}) {
  const completed = [];
  try {
    for (const step of steps) { const value = await step.run(context); completed.push({ step, value }); }
    return completed.map((item) => item.value);
  } catch (error) {
    for (const item of completed.reverse()) if (typeof item.step.compensate === "function") await item.step.compensate(context, item.value);
    throw error;
  }
}
