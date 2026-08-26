import { hydrateRoot } from "react-dom/client";
import { FlashDemo } from "./components/FlashDemo";

const el = document.getElementById("flash-demo-root");
if (el) {
  hydrateRoot(el, <FlashDemo />);
}
