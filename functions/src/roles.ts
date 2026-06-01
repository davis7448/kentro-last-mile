import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";

type Role = "admin" | "seller" | "driver" | "messenger";

export const setUserRole = onCall(async (request) => {
  const uid = String(request.data?.uid ?? "");
  const role = String(request.data?.role ?? "") as Role;
  const sellerId = request.data?.sellerId ? String(request.data.sellerId) : undefined;
  const driverId = request.data?.driverId ? String(request.data.driverId) : undefined;
  const messengerId = request.data?.messengerId ? String(request.data.messengerId) : undefined;

  if (!uid || !["admin", "seller", "driver", "messenger"].includes(role)) {
    throw new HttpsError("invalid-argument", "uid and a valid role are required.");
  }

  const userCount = (await getAuth().listUsers(2)).users.length;
  const isBootstrapAdmin = userCount === 1 && request.auth?.uid === uid && role === "admin";
  if (!isBootstrapAdmin && request.auth?.token.role !== "admin") {
    throw new HttpsError("permission-denied", "Only admins can assign roles.");
  }

  await getAuth().setCustomUserClaims(uid, {
    role,
    sellerId: role === "seller" ? sellerId : undefined,
    driverId: role === "driver" ? driverId : undefined,
    messengerId: role === "messenger" ? messengerId : undefined
  });

  return { ok: true };
});

export const createManagedUser = onCall(async (request) => {
  const existingUsers = (await getAuth().listUsers(1)).users.length;
  const bootstrapAdmin = existingUsers === 0 && request.data?.role === "admin";

  if (!bootstrapAdmin && request.auth?.token.role !== "admin") {
    throw new HttpsError("permission-denied", "Only admins can create users.");
  }

  const email = String(request.data?.email ?? "").trim().toLowerCase();
  const password = String(request.data?.password ?? "");
  const displayName = String(request.data?.name ?? "").trim();
  const role = String(request.data?.role ?? "") as Role;
  const profileId = request.data?.profileId ? String(request.data.profileId) : undefined;

  if (!email || password.length < 6 || !displayName || !["admin", "seller", "driver", "messenger"].includes(role)) {
    throw new HttpsError("invalid-argument", "email, password, name and a valid role are required.");
  }

  let user;
  let existing = false;
  try {
    user = await getAuth().createUser({ email, password, displayName });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code !== "auth/email-already-exists") throw error;
    user = await getAuth().getUserByEmail(email);
    existing = true;
    if (displayName && user.displayName !== displayName) {
      user = await getAuth().updateUser(user.uid, { displayName });
    }
  }
  await getAuth().setCustomUserClaims(user.uid, {
    role,
    sellerId: role === "seller" ? profileId : undefined,
    driverId: role === "driver" ? profileId : undefined,
    messengerId: role === "messenger" ? profileId : undefined
  });

  return { uid: user.uid, existing };
});

export const getBootstrapStatus = onCall(async () => {
  const existingUsers = (await getAuth().listUsers(1)).users.length;
  return { needsBootstrap: existingUsers === 0 };
});

export const repairOwnDriverProfile = onCall(async (request) => {
  const role = request.auth?.token.role;
  const driverId = typeof request.auth?.token.driverId === "string" ? request.auth.token.driverId : "";
  if (!request.auth || role !== "driver" || !driverId) {
    throw new HttpsError("permission-denied", "Only authenticated logistics leaders can repair their own profile.");
  }

  const user = await getAuth().getUser(request.auth.uid);
  const now = new Date().toISOString();
  const ref = getFirestore().collection("drivers").doc(driverId);
  const snap = await ref.get();
  const profile = {
    id: driverId,
    name: snap.exists ? String(snap.data()?.name ?? user.displayName ?? user.email ?? "Lider logistico") : user.displayName ?? user.email ?? "Lider logistico",
    phone: snap.exists ? String(snap.data()?.phone ?? "") : "",
    active: snap.exists ? snap.data()?.active !== false : true,
    updatedAt: now
  };
  await ref.set(profile, { merge: true });
  return { driver: profile };
});
