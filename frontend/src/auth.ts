const STORAGE_KEY = "probe20.auth";

export type AuthSession = {
  email: string;
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export type ProbeConfig = {
  apiEndpoint: string;
  userPoolId: string;
  userPoolClientId: string;
  region: string;
};

const CONFIG_KEY = "probe20.config";

export function loadConfig(): ProbeConfig | null {
  const fromEnv: ProbeConfig = {
    apiEndpoint: (import.meta.env.VITE_API_ENDPOINT || "").replace(/\/$/, ""),
    userPoolId: import.meta.env.VITE_USER_POOL_ID || "",
    userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID || "",
    region: import.meta.env.VITE_AWS_REGION || "us-east-1",
  };

  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<ProbeConfig>;
      return {
        apiEndpoint: (saved.apiEndpoint || fromEnv.apiEndpoint).replace(
          /\/$/,
          "",
        ),
        userPoolId: saved.userPoolId || fromEnv.userPoolId,
        userPoolClientId: saved.userPoolClientId || fromEnv.userPoolClientId,
        region: saved.region || fromEnv.region,
      };
    }
  } catch {
    /* ignore */
  }

  if (
    fromEnv.apiEndpoint &&
    fromEnv.userPoolId &&
    fromEnv.userPoolClientId
  ) {
    return fromEnv;
  }
  return null;
}

export function saveConfig(cfg: ProbeConfig) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

export function clearConfig() {
  localStorage.removeItem(CONFIG_KEY);
}

export function loadSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as AuthSession;
    if (!session.idToken || !session.expiresAt) return null;
    return session;
  } catch {
    return null;
  }
}

export function saveSession(session: AuthSession) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}

function cognitoUrl(region: string) {
  return `https://cognito-idp.${region}.amazonaws.com/`;
}

async function cognitoCall(
  region: string,
  target: string,
  body: Record<string, unknown>,
) {
  const res = await fetch(cognitoUrl(region), {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const msg =
      typeof data.message === "string"
        ? data.message
        : typeof data.__type === "string"
          ? data.__type
          : "Cognito request failed";
    throw new Error(msg);
  }
  return data;
}

function sessionFromAuthResult(
  email: string,
  authResult: Record<string, unknown>,
  refreshFallback?: string,
): AuthSession {
  const idToken = String(authResult.IdToken || "");
  const accessToken = String(authResult.AccessToken || "");
  const refreshToken = String(
    authResult.RefreshToken || refreshFallback || "",
  );
  const expiresIn = Number(authResult.ExpiresIn || 3600);
  if (!idToken) throw new Error("Missing IdToken from Cognito");
  return {
    email,
    idToken,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000 - 60_000,
  };
}

export async function signIn(
  cfg: ProbeConfig,
  email: string,
  password: string,
): Promise<AuthSession> {
  const data = await cognitoCall(cfg.region, "InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: cfg.userPoolClientId,
    AuthParameters: {
      USERNAME: email,
      PASSWORD: password,
    },
  });

  if (data.ChallengeName === "NEW_PASSWORD_REQUIRED") {
    const err = new Error("NEW_PASSWORD_REQUIRED") as Error & {
      session?: string;
      email?: string;
    };
    err.session = String(data.Session || "");
    err.email = email;
    throw err;
  }

  const authResult = data.AuthenticationResult as Record<string, unknown>;
  if (!authResult) throw new Error("Unexpected Cognito response");
  const session = sessionFromAuthResult(email, authResult);
  saveSession(session);
  return session;
}

export async function completeNewPassword(
  cfg: ProbeConfig,
  email: string,
  newPassword: string,
  challengeSession: string,
): Promise<AuthSession> {
  const data = await cognitoCall(cfg.region, "RespondToAuthChallenge", {
    ClientId: cfg.userPoolClientId,
    ChallengeName: "NEW_PASSWORD_REQUIRED",
    Session: challengeSession,
    ChallengeResponses: {
      USERNAME: email,
      NEW_PASSWORD: newPassword,
    },
  });

  const authResult = data.AuthenticationResult as Record<string, unknown>;
  if (!authResult) throw new Error("Failed to set new password");
  const session = sessionFromAuthResult(email, authResult);
  saveSession(session);
  return session;
}

export async function refreshSession(
  cfg: ProbeConfig,
  current: AuthSession,
): Promise<AuthSession> {
  if (!current.refreshToken) {
    throw new Error("No refresh token");
  }
  const data = await cognitoCall(cfg.region, "InitiateAuth", {
    AuthFlow: "REFRESH_TOKEN_AUTH",
    ClientId: cfg.userPoolClientId,
    AuthParameters: {
      REFRESH_TOKEN: current.refreshToken,
    },
  });
  const authResult = data.AuthenticationResult as Record<string, unknown>;
  if (!authResult) throw new Error("Refresh failed");
  const session = sessionFromAuthResult(
    current.email,
    authResult,
    current.refreshToken,
  );
  saveSession(session);
  return session;
}

export async function getIdToken(cfg: ProbeConfig): Promise<string> {
  let session = loadSession();
  if (!session) throw new Error("Not signed in");
  if (Date.now() < session.expiresAt) return session.idToken;
  session = await refreshSession(cfg, session);
  return session.idToken;
}

export function isConfigured(cfg: ProbeConfig | null): boolean {
  return Boolean(
    cfg?.apiEndpoint && cfg.userPoolId && cfg.userPoolClientId && cfg.region,
  );
}
