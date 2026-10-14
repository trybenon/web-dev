import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  it("renders the main page heading", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("<h1>Совместный просмотр видео</h1>");
  });
});
