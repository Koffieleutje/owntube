import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, SafeAreaView, StyleSheet } from "react-native";
import { Shell } from "@/components/Shell";
import { clearToken, getToken } from "@/lib/auth-token";
import { armSessionExpiry, disarmSessionExpiry } from "@/lib/session";
import { TrpcProvider } from "@/lib/trpc-react";
import { LoginScreen } from "@/screens/LoginScreen";
import { colors } from "@/theme";

type AuthState = "checking" | "signedOut" | "signedIn";

export default function App() {
  const [auth, setAuth] = useState<AuthState>("checking");

  useEffect(() => {
    getToken().then((token) => setAuth(token ? "signedIn" : "signedOut"));
  }, []);

  /**
   * A stored token only means "signed in" until the server disagrees. The
   * device token expires after 30 days with no refresh, and without this the
   * app sat on a shell where every screen said "Authentication required" and
   * nothing offered a way back — see lib/session.ts.
   */
  useEffect(() => {
    if (auth !== "signedIn") return;
    armSessionExpiry(() => setAuth("signedOut"));
    return disarmSessionExpiry;
  }, [auth]);

  const signOut = () => {
    clearToken().then(() => setAuth("signedOut"));
  };

  return (
    <TrpcProvider>
      <SafeAreaView style={styles.root}>
        <StatusBar hidden />
        {auth === "checking" ? (
          <ActivityIndicator
            style={styles.centered}
            size="large"
            color={colors.brand}
          />
        ) : auth === "signedIn" ? (
          <Shell onSignOut={signOut} />
        ) : (
          <LoginScreen onLoggedIn={() => setAuth("signedIn")} />
        )}
      </SafeAreaView>
    </TrpcProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  centered: { flex: 1 },
});
