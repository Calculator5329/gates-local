import type { FullResult, Reporter, TestCase, TestResult, TestStep } from "@playwright/test/reporter";

// Informational only: machine contention must never become a correctness failure.
export default class BudgetReporter implements Reporter {
  private spans = new Map<string, Record<string, number>>();

  onStepEnd(test: TestCase, _result: TestResult, step: TestStep): void {
    if (!["reset backend", "page load", "page ready", "teardown"].includes(step.title)) return;
    const spans = this.spans.get(test.id) ?? {};
    spans[step.title] = (spans[step.title] ?? 0) + step.duration;
    this.spans.set(test.id, spans);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === "skipped" || /flicker audit|state-swap survey|measure mixed Markdown/.test(test.titlePath().join(" "))) return;
    const spans = this.spans.get(test.id) ?? {};
    const measured = Object.values(spans).reduce((sum, duration) => sum + duration, 0);
    console.log(`JOURNEY_MS ${JSON.stringify({ test: test.titlePath().join(" > "), total: result.duration, ...spans, remaining: Math.max(0, result.duration - measured) })}`);
    if (result.duration <= 5000) return;
    console.warn(`[budget warning] ${(result.duration / 1000).toFixed(1)}s: ${test.title}`);
    if (result.duration > 10_000) {
      const reason = test.annotations.find(annotation => annotation.type === "budget")?.description;
      console.warn(reason ? `[budget explanation] ${reason}` : `[budget warning] Over 10s: add a budget annotation explaining the required work: ${test.title}`);
    }
  }

  onEnd(result: FullResult): void {
    console.log(`BROWSER_SUITE_MS=${Math.round(result.duration)}`);
    if (result.duration > 360_000) console.warn(`[budget warning] Browser phase took ${(result.duration / 1000).toFixed(1)}s, over the six-minute suite target.`);
  }
}
