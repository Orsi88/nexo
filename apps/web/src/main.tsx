import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { DialogHost } from "./dialogs.tsx";
import "./styles.css";
import "./refine.css";

const root = document.getElementById("root");
if (!root) throw new Error("elemento #root ausente");

createRoot(root).render(
  <StrictMode>
    <App />
    <DialogHost />
  </StrictMode>,
);
