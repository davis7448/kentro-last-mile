import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import {
  clearIndexedDbPersistence,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  terminate,
  type Firestore
} from "firebase/firestore";
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

// `initializeFirestore` solo admite UNA llamada por app, y `getFirebaseClient()` se invoca
// decenas de veces por render. El cliente entero se memoiza aqui; sin esto la segunda llamada
// lanzaria "Firestore has already been started".
let cachedClient: FirebaseClient | null = null;

/**
 * La cache persistente NO es para la calle.
 *
 * En consola (admin, tienda) vale mucho: sin ella cada recarga volvia a bajar por red las ~11.500
 * lecturas del estado. Pero el domiciliario baja todo su historico sin recortar, y persistirlo en
 * IndexedDB de un telefono compartido tiene un coste que se paga en el peor momento: Firebase Auth
 * usa ESE MISMO disco, asi que con la cache saturada `getIdToken()` se cuelga y la subida de la
 * foto de entrega no llega ni a empezar. Con varias pestanas abiertas el lock lo empeora.
 *
 * Nadie en la calle recarga la app buscando velocidad de arranque; lo que necesita es poder cerrar
 * el pedido. Por eso driver y messenger van con cache en memoria.
 */
/** Espejo de `sessionKey` en operations-app.tsx. Se duplica a proposito: importarlo desde el
 *  monolito de UI crearia un ciclo (el monolito importa este modulo). */
const sessionStorageKey = "kentro-session";

function usesPersistentCache(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(sessionStorageKey);
    if (!raw) return false;
    const role = (JSON.parse(raw) as { role?: string }).role;
    return role === "admin" || role === "seller" || role === "seller_logistics";
  } catch {
    // Sesion ilegible: en la duda, memoria. Es el modo que nunca bloquea.
    return false;
  }
}

function createFirestore(app: FirebaseApp): Firestore {
  if (!usesPersistentCache()) return getFirestore(app);
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
  } catch (error) {
    // Navegador sin IndexedDB (modo privado antiguo, webview restringida) o Firestore ya iniciado.
    console.warn("Cache persistente no disponible, se usa cache en memoria.", error);
    return getFirestore(app);
  }
}

export function getFirebaseClient(): FirebaseClient | null {
  if (!firebaseEnabled()) return null;
  if (cachedClient) return cachedClient;

  const app =
    getApps().length > 0
      ? getApp()
      : initializeApp(firebaseConfig());

  cachedClient = {
    app,
    auth: getAuth(app),
    db: createFirestore(app),
    storage: getStorage(app)
  };
  return cachedClient;
}

/** Borra la cache local de Firestore. Los equipos de la operacion son compartidos (mensajeros,
 *  tiendas), asi que al cerrar sesion no puede quedar el ledger del usuario anterior en el disco
 *  del siguiente. Hay que terminar la instancia antes de borrar: es requisito del SDK. */
export async function clearFirebaseLocalCache(): Promise<void> {
  const client = cachedClient;
  if (!client) return;
  cachedClient = null;
  try {
    await terminate(client.db);
    await clearIndexedDbPersistence(client.db);
  } catch (error) {
    // Otra pestana con la misma cache abierta impide el borrado; no es motivo para bloquear el logout.
    console.warn("No se pudo limpiar la cache local de Firestore.", error);
  }
}
