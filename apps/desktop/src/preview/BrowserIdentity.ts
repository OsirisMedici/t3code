export const previewUserAgent = (url: string, userAgent: string) =>
  new URL(url).origin === "https://web.whatsapp.com"
    ? userAgent.replace(/ Electron\/\S+/g, "")
    : userAgent;

export const installBrowserIdentity = (
  url: string,
  target: Pick<Navigator, "userAgent" | "appVersion">,
) => {
  const userAgent = previewUserAgent(url, target.userAgent);
  if (userAgent === target.userAgent) return;
  Object.defineProperties(target, {
    userAgent: { value: userAgent, configurable: true },
    appVersion: { value: previewUserAgent(url, target.appVersion), configurable: true },
  });
};
