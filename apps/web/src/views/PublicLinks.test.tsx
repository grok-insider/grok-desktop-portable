import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PublicLinks } from "./PublicLinks";

it("opens first-party management without cross-site account cookies or relay dependence", () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  render(<PublicLinks />);
  expect(screen.getByRole("link", {name: "Manage public links on Fabrials"})).toHaveAttribute("href", "https://fabrials.com/account/publications");
  expect(screen.getByText(/even when your computer is offline/)).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
});
