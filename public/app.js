const iframe = document.getElementById("view");
const start = document.getElementById("start");
const urlInput = document.getElementById("url");
const progress = document.getElementById("progress");
const backBtn = document.getElementById("back");
const fwdBtn = document.getElementById("fwd");
const reloadBtn = document.getElementById("reload");
const homeBtn = document.getElementById("home");

const stack = [];
let index = -1;
let browsing = false;

function looksLikeUrl(raw) {
  return /^(https?:\/\/)/i.test(raw) || /^[\w.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(raw);
}

function toTarget(raw) {
  const value = raw.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (looksLikeUrl(value)) return "https://" + value;
  return "https://www.google.com/search?gbv=1&q=" + encodeURIComponent(value);
}

function updateNav() {
  backBtn.disabled = index <= 0;
  fwdBtn.disabled = index < 0 || index >= stack.length - 1;
}

function setLoading(on) {
  progress.hidden = !on;
}

function showBrowser() {
  browsing = true;
  start.hidden = true;
  iframe.hidden = false;
}

function goHome() {
  browsing = false;
  iframe.hidden = true;
  iframe.removeAttribute("src");
  start.hidden = false;
  urlInput.value = "";
  setLoading(false);
  updateNav();
  document.getElementById("start-q").focus();
}

function go(raw, { push = true } = {}) {
  const target = toTarget(raw);
  if (!target) return;
  urlInput.value = target;
  showBrowser();
  setLoading(true);
  iframe.src = "/proxy?url=" + encodeURIComponent(target);
  if (push) {
    stack.splice(index + 1);
    stack.push(target);
    index = stack.length - 1;
  }
  updateNav();
}

document.getElementById("omnibox").addEventListener("submit", (e) => {
  e.preventDefault();
  go(urlInput.value);
});

document.getElementById("start-form").addEventListener("submit", (e) => {
  e.preventDefault();
  go(document.getElementById("start-q").value);
});

document.querySelectorAll("[data-go]").forEach((btn) => {
  btn.addEventListener("click", () => go(btn.getAttribute("data-go")));
});

backBtn.addEventListener("click", () => {
  if (index <= 0) return;
  index -= 1;
  go(stack[index], { push: false });
});

fwdBtn.addEventListener("click", () => {
  if (index >= stack.length - 1) return;
  index += 1;
  go(stack[index], { push: false });
});

reloadBtn.addEventListener("click", () => {
  if (!browsing || index < 0) return;
  go(stack[index], { push: false });
});

homeBtn.addEventListener("click", goHome);

iframe.addEventListener("load", () => setLoading(false));

window.addEventListener("message", (e) => {
  if (!e.data) return;
  if (e.data.type === "prism-go" && e.data.url) {
    go(e.data.url);
  }
  if (e.data.type === "prism-url" && e.data.url) {
    urlInput.value = e.data.url;
    if (stack[index] !== e.data.url) {
      stack.splice(index + 1);
      stack.push(e.data.url);
      index = stack.length - 1;
      updateNav();
    }
  }
});

updateNav();
