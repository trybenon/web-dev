// @vitest-environment jsdom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import App from "./App.vue";

describe("App", () => {
  it("renders the main page heading", () => {
    const wrapper = mount(App);

    expect(wrapper.get("h1").text()).toBe("Совместный просмотр видео");

    wrapper.unmount();
  });
  it("shows the local demo link, author, license and modification notice", () => {
    const wrapper = mount(App);
    const attribution = wrapper.get('[aria-label="Демонстрационный ролик"]');

    expect(attribution.get('a[href="/media/demo.webm"]').text()).toBe(
      "Открыть деморолик",
    );
    expect(attribution.text()).toContain("Blender Foundation");
    expect(
      attribution
        .get('a[href="https://creativecommons.org/licenses/by/3.0/"]')
        .text(),
    ).toBe("CC BY 3.0");
    expect(attribution.text()).toContain("обрезан и перекодирован");

    wrapper.unmount();
  });
});
