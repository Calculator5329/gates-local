import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { connect, initialView, threadFromHash } from "./session.ts";
import { setState } from "./store.ts";
import { syncTitleBar } from "./titlebar.ts";
import "./styles.css";
// Draft restoration is required before connecting. These tiny shared helpers
// use startup's gzip dictionary instead of two separate chunk wrappers.
import "./draft-persistence.ts";
import "./copy.ts";

syncTitleBar();

// a reload keeps the open thread: #thread=<id>
setState(initialView(threadFromHash()));
connect();

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary scope="app"><App /></ErrorBoundary>
  </StrictMode>,
);
