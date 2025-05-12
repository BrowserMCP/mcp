/// <reference types="chrome" />
// Saves options to chrome.storage.local
function saveOptions(e: Event): void {
  e.preventDefault();
  const tokenInput = document.getElementById('token') as HTMLInputElement;
  const portInput = document.getElementById('port') as HTMLInputElement;
  const token = tokenInput.value.trim();
  const port = portInput.value.trim();
  if (token.length === 0 || token.length > 64) {
    showStatus('Token must be between 1 and 64 characters.', true);
    return;
  }
  chrome.storage.local.set({
    mcpToken: token,
    mcpPort: port ? parseInt(port, 10) : null
  }, () => {
    showStatus('Options saved.');
  });
}

// Restores options from chrome.storage.local
function restoreOptions(): void {
  chrome.storage.local.get(['mcpToken', 'mcpPort'], (items: { [key: string]: any }) => {
    const tokenInput = document.getElementById('token') as HTMLInputElement;
    const portInput = document.getElementById('port') as HTMLInputElement;
    tokenInput.value = items.mcpToken || '';
    portInput.value = items.mcpPort || '';
  });
}

// Restore defaults
function restoreDefaults(): void {
  chrome.storage.local.set({ mcpToken: '', mcpPort: null }, () => {
    restoreOptions();
    showStatus('Defaults restored.');
  });
}

function showStatus(message: string, isError = false): void {
  const status = document.getElementById('status') as HTMLElement;
  status.textContent = message;
  status.style.color = isError ? 'red' : 'green';
  setTimeout(() => { status.textContent = ''; }, 3000);
}

document.getElementById('options-form')!.addEventListener('submit', saveOptions);
document.getElementById('restore')!.addEventListener('click', restoreDefaults);
document.addEventListener('DOMContentLoaded', restoreOptions); 