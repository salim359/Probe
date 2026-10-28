/**
 * Copy to config.js and fill in stack outputs after `sam deploy`.
 *
 *   cp ui/config.example.js ui/config.js
 *
 * Or paste values in the Settings panel in the UI (saved to localStorage).
 */
window.TROUBLESHOOT_CONFIG = {
  apiUrl: "https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/prod/investigate",
  userPoolId: "us-east-1_XXXXXXXXX",
  userPoolClientId: "xxxxxxxxxxxxxxxxxxxxxxxxxx",
  region: "us-east-1",
};
