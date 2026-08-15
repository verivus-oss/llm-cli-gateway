import path from "node:path";
import { z } from "zod/v3";

export const REVIEW_RUN_AUTHORIZATION_SCHEMA_VERSION = "review-run-authorization.v1";

const reviewRunAuthorizationSchema = z.object({
  schemaVersion: z.literal(REVIEW_RUN_AUTHORIZATION_SCHEMA_VERSION),
  /** Canonical path returned by repository authorization for the caller's selector. */
  repositoryPath: z.string().min(1),
  /** Git root that was captured and supplied to the reviewer jobs. */
  repositoryRoot: z.string().min(1),
  judgeProvider: z.string().min(1).nullable(),
  allowApiUpload: z.boolean(),
  /**
   * Issue #270: the caller accepted cursor trusting a repository that is not a
   * registered workspace for cursor. It lives HERE, on the durable
   * authorization, rather than as a separate argument, because the roster and
   * the judge both need it and they run in different tool calls. Round 4 of
   * review found it was roster-only: the judge is started later by
   * synthesize_validation, which had no way to learn the operator had consented.
   *
   * Defaulted so runs authorized before this field existed still parse.
   */
  trustCursorWorkspace: z.boolean().default(false),
});

export type ReviewRunAuthorization = z.infer<typeof reviewRunAuthorizationSchema>;

/**
 * Return true only when the resolved Git root stays inside the repository path
 * authorized for the caller. Both inputs are expected to be canonical absolute
 * paths at the review admission boundary.
 */
export function isAuthorizedReviewRepositoryRoot(
  repositoryPath: string,
  repositoryRoot: string
): boolean {
  const relative = path.relative(repositoryPath, repositoryRoot);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export function parseReviewRunAuthorization(requestJson: string): ReviewRunAuthorization | null {
  try {
    const request = z
      .object({ reviewAuthorization: reviewRunAuthorizationSchema })
      .safeParse(JSON.parse(requestJson));
    return request.success ? request.data.reviewAuthorization : null;
  } catch {
    return null;
  }
}
