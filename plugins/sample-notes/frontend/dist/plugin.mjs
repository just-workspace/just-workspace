const { Fragment: e, computed: t, createCommentVNode: n, createElementBlock: r, createElementVNode: i, defineComponent: a, inject: o, normalizeClass: s, onMounted: c, openBlock: l, ref: u, renderList: d, toDisplayString: f, unref: p, vModelText: m, withDirectives: h } = window.__VUE__;
//#region sample-notes/frontend/page.vue?vue&type=script&setup=true&lang.ts
var g = {
	key: 0,
	class: "h-full flex"
}, _ = { class: "w-64 border-r flex flex-col bg-card" }, v = { class: "p-3 border-b flex items-center justify-between" }, y = ["disabled"], b = { class: "flex-1 overflow-auto" }, x = {
	key: 0,
	class: "p-4 text-center text-sm text-muted-foreground"
}, S = {
	key: 1,
	class: "p-4 text-center text-sm text-muted-foreground"
}, C = ["onClick"], w = { class: "font-medium truncate" }, T = { class: "text-xs text-muted-foreground mt-0.5 truncate" }, E = { class: "flex-1 flex flex-col" }, D = {
	key: 0,
	class: "flex-1 flex flex-col"
}, O = { class: "p-3 border-b flex items-center gap-2" }, k = ["disabled"], A = {
	key: 1,
	class: "flex-1 flex items-center justify-center text-muted-foreground"
}, j = /* @__PURE__ */ a({
	__name: "page",
	setup(a) {
		let j = o("pluginApi"), M = j.user, N = j.$fetch, P = u([]), F = u(!1), I = u(!1), L = u(null), R = u(""), z = u(""), B = t(() => P.value.find((e) => e.id === L.value) || null);
		async function V() {
			F.value = !0;
			try {
				let e = await N("/api/plugins/notes");
				P.value = e.notes;
			} catch (e) {
				console.error("fetchNotes error:", e);
			} finally {
				F.value = !1;
			}
		}
		function H(e) {
			L.value = e.id, R.value = e.title, z.value = e.content;
		}
		async function U() {
			I.value = !0;
			try {
				let e = await N("/api/plugins/notes", {
					method: "POST",
					body: {
						title: "새 메모",
						content: ""
					}
				});
				P.value.unshift(e), H(e);
			} catch (e) {
				console.error("createNote error:", e);
			} finally {
				I.value = !1;
			}
		}
		async function W() {
			if (L.value) {
				I.value = !0;
				try {
					let e = await N(`/api/plugins/notes/${L.value}`, {
						method: "PATCH",
						body: {
							title: R.value,
							content: z.value
						}
					}), t = P.value.findIndex((t) => t.id === e.id);
					t >= 0 && (P.value[t] = e);
				} catch (e) {
					console.error("saveNote error:", e);
				} finally {
					I.value = !1;
				}
			}
		}
		async function G(e) {
			if (confirm("이 메모를 삭제하시겠습니까?")) try {
				await N(`/api/plugins/notes/${e}`, { method: "DELETE" }), P.value = P.value.filter((t) => t.id !== e), L.value === e && (L.value = null, R.value = "", z.value = "");
			} catch (e) {
				console.error("deleteNote error:", e);
			}
		}
		return c(() => {
			M.value && V();
		}), (t, a) => p(M) ? (l(), r("div", g, [
			n(" Sidebar: note list "),
			i("div", _, [i("div", v, [a[4] ||= i("h2", { class: "font-semibold text-sm" }, "메모", -1), i("button", {
				onClick: U,
				disabled: I.value,
				class: "w-7 h-7 rounded-md flex items-center justify-center hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
			}, [...a[3] ||= [i("svg", {
				xmlns: "http://www.w3.org/2000/svg",
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				"stroke-width": "2",
				"stroke-linecap": "round",
				"stroke-linejoin": "round",
				class: "h-4 w-4"
			}, [i("line", {
				x1: "12",
				y1: "5",
				x2: "12",
				y2: "19"
			}), i("line", {
				x1: "5",
				y1: "12",
				x2: "19",
				y2: "12"
			})], -1)]], 8, y)]), i("div", b, [F.value ? (l(), r("div", x, " 로딩 중... ")) : P.value.length === 0 ? (l(), r("div", S, " 메모가 없습니다 ")) : (l(!0), r(e, { key: 2 }, d(P.value, (e) => (l(), r("button", {
				key: e.id,
				onClick: (t) => H(e),
				class: s(["w-full text-left px-3 py-2.5 border-b text-sm transition-colors", L.value === e.id ? "bg-accent" : "hover:bg-accent/50"])
			}, [i("div", w, f(e.title || "(제목 없음)"), 1), i("div", T, f(e.content?.substring(0, 50) || "(내용 없음)"), 1)], 10, C))), 128))])]),
			n(" Editor "),
			i("div", E, [B.value ? (l(), r("div", D, [i("div", O, [
				h(i("input", {
					autocomplete: "off",
					"onUpdate:modelValue": a[0] ||= (e) => R.value = e,
					placeholder: "제목",
					class: "flex-1 bg-transparent border-none text-lg font-semibold focus:outline-none"
				}, null, 512), [[m, R.value]]),
				i("button", {
					onClick: W,
					disabled: I.value,
					class: "px-3 py-1.5 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
				}, f(I.value ? "저장 중..." : "저장"), 9, k),
				i("button", {
					onClick: a[1] ||= (e) => G(B.value.id),
					class: "px-3 py-1.5 text-sm font-medium rounded-md border hover:bg-destructive hover:text-destructive-foreground transition-colors"
				}, " 삭제 ")
			]), h(i("textarea", {
				autocomplete: "off",
				"onUpdate:modelValue": a[2] ||= (e) => z.value = e,
				placeholder: "내용을 입력하십시오...",
				class: "flex-1 p-4 bg-transparent resize-none focus:outline-none text-sm leading-relaxed"
			}, null, 512), [[m, z.value]])])) : (l(), r("div", A, [...a[5] ||= [i("div", { class: "text-center" }, [i("svg", {
				xmlns: "http://www.w3.org/2000/svg",
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				"stroke-width": "1.5",
				"stroke-linecap": "round",
				"stroke-linejoin": "round",
				class: "h-12 w-12 mx-auto mb-3 opacity-40"
			}, [i("path", { d: "M12 20h9 M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" })]), i("p", { class: "text-sm" }, "메모를 선택하거나 새로 만드세요")], -1)]]))])
		])) : n("v-if", !0);
	}
});
//#endregion
export { j as default };
