/**
 * "org" exists only in the API: the server stores an org site as "private"
 * plus an audience, so anything that does not understand the audience
 * (an older server, a missing link) treats it as owner-only.
 */
export type Visibility = "public" | "unlisted" | "private" | "org";

export interface SiteFileInput {
  path: string;
  /** UTF-8 text content (mutually exclusive with contentBase64) */
  content?: string;
  /** Base64-encoded binary content */
  contentBase64?: string;
}

export interface CreateSiteRequest {
  title?: string;
  slug?: string;
  visibility?: Visibility;
  ttl?: string | number | null;
  note?: string;
  files: SiteFileInput[];
}

export interface SiteResponse {
  id: string;
  url: string;
  versionId: string;
  title: string | null;
  slug: string | null;
  visibility: Visibility;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  byteSize: number;
  fileCount: number;
}

export interface SiteListItem {
  id: string;
  url: string;
  title: string | null;
  slug: string | null;
  visibility: Visibility;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  byteSize: number;
  currentVersionId: string | null;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export interface CreateKeyResponse {
  id: string;
  name: string;
  token: string;
  createdAt: string;
}
