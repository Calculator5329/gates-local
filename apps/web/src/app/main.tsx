import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, watchApp } from "./App.tsx";
import { preloadScreens } from "./screens.tsx";
import { watchComposer } from "../composer/Composer.tsx";
import { readAloud } from "../voice/talk.ts";
import { watchPickerReady } from "../picker/picker-entry.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { connect, initialView, pull, threadFromHash } from "../lib/session/index.ts";
import { computerOnlyMethods } from "../lib/session/platform.ts";
import { getState, setState, subscribe } from "../lib/store/store.ts";
import { watchFirstModel } from "../runtime/first-model.ts";
import { syncTitleBar } from "./titlebar.ts";
import "./styles.css";
// why: static imports put these in the startup chunk, so drafts restore before connect()
import "../composer/draft-persistence.ts";
import "../lib/ui/copy.ts";

syncTitleBar();

setState({ ...initialView(threadFromHash()), unavailable: computerOnlyMethods() });
connect();
watchApp();
watchComposer();
readAloud();
watchPickerReady();
watchFirstModel({ getState, subscribe, pull });

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary scope="app"><App /></ErrorBoundary>
  </StrictMode>,
);
preloadScreens();
