/** Plugin id and module-table registration key. */
export const NS = 'dsh-feedback-bridge';

/** Host status route path, used before a document base URL is available. */
export const STATUS_PATH = '/dsh-feedback-bridge/status';

/** Host draft route path, used before a document base URL is available. */
export const DRAFT_PATH = '/dsh-feedback-bridge/draft';

/** Host feedback-assist route path, used before a document base URL is available. */
export const ASSIST_PATH = '/dsh-feedback-bridge/assist';

/** Host similarity route path, used before a document base URL is available. */
export const SIMILARITY_PATH = '/dsh-feedback-bridge/similarity';

/**
 * Non-localized product-policy constant: the official DeepSeek Harness
 * GitHub Discussions destination for manual submission guidance. Kept out
 * of the locale dictionaries because the URL itself never translates.
 */
export const OFFICIAL_DISCUSSIONS_URL = 'https://github.com/deepseek-ai/deepseek-harness/discussions';