import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getStorage, type FirebaseStorage } from "firebase/storage";

type FirebaseClient = {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  storage: FirebaseStorage;
};

const fallbackFirebaseConfig = {
  apiKey: "AIzaSyAXY_lwmuAvXCmix45QrmEG-hiwAWmNI-g",
  authDomain: "kentro-last-mile.firebaseapp.com",
  projectId: "kentro-last-mile",
  storageBucket: "kentro-last-mile.firebasestorage.app",
  messagingSenderId: "769983034379",
  appId: "1:769983034379:web:cdaa06c1d6986462cd830e"
};

function firebaseConfig() {
  return {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || fallbackFirebaseConfig.apiKey,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || fallbackFirebaseConfig.authDomain,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || fallbackFirebaseConfig.projectId,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || fallbackFirebaseConfig.storageBucket,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || fallbackFirebaseConfig.messagingSenderId,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || fallbackFirebaseConfig.appId
  };
}

function hasFirebaseEnv() {
  const config = firebaseConfig();
  return Boolean(
    config.apiKey &&
      config.authDomain &&
      config.projectId &&
      config.appId
  );
}

export function firebaseEnabled() {
  return process.env.NEXT_PUBLIC_USE_FIRESTORE !== "false" && hasFirebaseEnv();
}

export function getFirebaseClient(): FirebaseClient | null {
  if (!firebaseEnabled()) return null;

  const app =
    getApps().length > 0
      ? getApp()
      : initializeApp(firebaseConfig());

  return {
    app,
    auth: getAuth(app),
    db: getFirestore(app),
    storage: getStorage(app)
  };
}
