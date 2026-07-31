/**
 * Effects the host could not confirm.
 *
 * Light does not know whether these happened. The real resolution is in the
 * user's own workspace, so this offers exactly one action — saying it has been
 * seen — and never retry or undo (plan §7.5). It also does not block anything:
 * turning a warning into a hard stop would make an ambiguous effect worse than
 * a failed one.
 */

import { TriangleAlert } from "lucide-react";
import { Button, Card, SectionLabel } from "../components/ui";
import { reviewCauseMessage, type ReviewProjection } from "../services/outcomes";

export function ReviewBanner({
  reviews,
  busy,
  onAcknowledge,
}: {
  reviews: ReviewProjection[];
  busy: boolean;
  onAcknowledge: (recordId: string) => void;
}) {
  if (reviews.length === 0) {
    return null;
  }

  return (
    <Card className="border-warning/40 bg-warning-soft/30">
      <SectionLabel>Needs review</SectionLabel>
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <div className="flex flex-1 flex-col gap-3">
          <p className="text-body-lg text-foreground">
            {reviews.length === 1
              ? "One action was interrupted before Grok Desktop Portable could confirm the result."
              : `${reviews.length} actions were interrupted before Grok Desktop Portable could confirm the result.`}{" "}
            They were not retried. Check your workspace to see what actually happened.
          </p>
          <ul className="flex flex-col gap-2">
            {reviews.map((review) => (
              <li
                key={review.recordId}
                className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2"
              >
                <span className="text-body text-muted-foreground">
                  <span className="font-medium text-foreground">{review.operation}</span> —{" "}
                  {reviewCauseMessage(review.cause)}
                </span>
                <Button
                  onClick={() => onAcknowledge(review.recordId)}
                  disabled={busy}
                  aria-label={`Mark ${review.operation} as reviewed`}
                >
                  Mark as reviewed
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}
