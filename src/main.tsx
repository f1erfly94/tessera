import {StrictMode} from "react";
import {createRoot} from "react-dom/client";

import {App, resolveRoute} from "./App";
import "./styles.css";

const route = await resolveRoute();

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App route={route} />
    </StrictMode>,
);
