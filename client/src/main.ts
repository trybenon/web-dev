import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import * as Sentry from "@sentry/vue";
import { sanitizeErrorEvent } from "@watch-together/shared";

import "element-plus/dist/index.css";
import "element-plus/theme-chalk/dark/css-vars.css";
import "./styles/index.css";

import App from "./App.vue";

const app = createApp(App);

app.use(createPinia());
app.use(ElementPlus);
const dsn = import.meta.env.VITE_BUGSINK_DSN;

if (dsn) {
  Sentry.init({
    app,
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_APP_RELEASE,
    sendDefaultPii: false,
    beforeSend: sanitizeErrorEvent,
  });
}
app.mount("#root");
