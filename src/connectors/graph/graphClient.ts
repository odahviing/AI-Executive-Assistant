import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials';
import { config } from '../../config';

// ── Auth ─────────────────────────────────────────────────────────────────────

function createGraphClient(): Client {
  const credential = new ClientSecretCredential(
    config.AZURE_TENANT_ID,
    config.AZURE_CLIENT_ID,
    config.AZURE_CLIENT_SECRET
  );
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ['https://graph.microsoft.com/.default'],
  });
  return Client.initWithMiddleware({ authProvider });
}

let _client: Client | null = null;
export function getClient(): Client {
  if (!_client) _client = createGraphClient();
  return _client;
}
