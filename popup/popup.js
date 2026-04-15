// Minimal launcher. Opens (or focuses) the dashboard tab.
const api = (typeof browser !== 'undefined') ? browser : chrome;
const DASHBOARD_URL = api.runtime.getURL('dashboard/dashboard.html');

async function openDashboard() {
  // Focus an existing dashboard tab if one is open.
  const tabs = await new Promise(resolve => api.tabs.query({ url: DASHBOARD_URL }, resolve));
  if (tabs && tabs.length) {
    api.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId != null) api.windows && api.windows.update(tabs[0].windowId, { focused: true });
  } else {
    api.tabs.create({ url: DASHBOARD_URL });
  }
  window.close(); // dismiss the popup
}

document.getElementById('open').addEventListener('click', openDashboard);
// Open the dashboard immediately if the user clicked the toolbar icon and
// doesn't want to click twice. Comment this out if you prefer a prompt.
openDashboard();
