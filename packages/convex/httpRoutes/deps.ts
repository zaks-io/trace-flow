import type * as oauthModule from '../mcp/oauth';
import type * as tokensModule from '../mcp/tokens';

// Dependencies that can be injected for testing
export interface HttpDeps {
  oauth: typeof oauthModule;
  tokens: typeof tokensModule;
}
