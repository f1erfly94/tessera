import {StrictMode} from "react";
import {createRoot} from "react-dom/client";

import {App, resolveRoute} from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App route={resolveRoute()} />
    </StrictMode>,
);
