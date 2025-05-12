/// <reference types="chrome" />
// Utility to get token and port from storage
function getMcpSettings(callback: (settings: { token: string; port: number }) => void): void {
  chrome.storage.local.get(['mcpToken', 'mcpPort'], (items: { [key: string]: any }) => {
    callback({
      token: items.mcpToken || '',
      port: items.mcpPort || 9234 // default port
    });
  });
}

// Example: Use settings for WebSocket connection
function connectToMcpServer(): void {
  getMcpSettings(({ token, port }) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ token }));
      // Optionally, send capabilities after auth
      ws.send(JSON.stringify({ type: 'capabilities', data: getCapabilities() }));
    };
    // ... handle other ws events ...
  });
}

// Capabilities reporting
type Capabilities = {
  extension: string;
  version: string;
  features: string[];
};

function getCapabilities(): Capabilities {
  return {
    extension: 'browser-mcp',
    version: chrome.runtime.getManifest().version,
    features: ['token-auth', 'port-override', 'capabilities-report']
  };
}

// Listen for messages (optional, e.g., for getCapabilities)
chrome.runtime.onMessage.addListener((request: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
  if (request.type === 'getCapabilities') {
    sendResponse(getCapabilities());
  }
  // ... handle other messages ...
}); 