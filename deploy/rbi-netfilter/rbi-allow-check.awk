# ws-rbi-netfilter — 동적 허용 파일 줄 검사(apply.sh 가 부른다). 백엔드가 쓴 줄을 믿지 않고 다시 본다.
#   입력 줄: "IPv4:포트[ force]  # 주석"   (# 로 시작하는 줄·빈 줄 무시)
#   -v ceil  : 들어갈 수 있는 상한 CIDR 목록(쉼표)
#   -v deny  : 언제나 거부할 CIDR 목록(루프백·링크로컬·멀티캐스트·세션 대역·도커 브리지·RBI_DENY)
#   -v selfs : 이 호스트 자신의 주소·기본 게이트웨이(쉼표) — "force" 가 붙은 줄만 통과
#   출력: 1행 = 통과한 "IP:포트" 쉼표 목록 · 2행 = 거부한 "IP:포트 이유" 를 | 로
function ip2n(ip,   o, n, i) {
    n = split(ip, o, ".")
    if (n != 4) return -1
    for (i = 1; i <= 4; i++) if (o[i] !~ /^[0-9]+$/ || length(o[i]) > 3 || o[i] + 0 > 255) return -1
    return ((o[1] * 256 + o[2]) * 256 + o[3]) * 256 + o[4]
}
function incidr(n, list,   c, k, j, p, b, base, size) {
    k = split(list, c, ",")
    for (j = 1; j <= k; j++) {
        if (c[j] == "") continue
        if (split(c[j], p, "/") == 2) b = p[2] + 0; else b = 32
        base = ip2n(p[1])
        if (base < 0 || b < 0 || b > 32) continue
        size = 2 ^ (32 - b)
        base = base - (base % size)
        if (n >= base && n < base + size) return 1
    }
    return 0
}
BEGIN { ok = ""; rej = "" }
{
    sub(/#.*/, "")
    gsub(/^[ \t]+|[ \t]+$/, "")
    if ($0 == "") next
    nf = split($0, f, /[ \t]+/)
    hp = f[1]
    force = (nf >= 2 && f[2] == "force")
    if (nf > 2 || (nf == 2 && !force) || hp !~ /^[0-9.]+:[0-9]+$/) { rej = rej "|" hp " format"; next }
    split(hp, x, ":")
    n = ip2n(x[1]); port = x[2] + 0
    if (n < 0 || port < 1 || port > 65535 || length(x[2]) > 5) { rej = rej "|" hp " format"; next }
    if (incidr(n, deny)) { rej = rej "|" hp " denied"; next }
    if (!incidr(n, ceil)) { rej = rej "|" hp " outside-ceiling"; next }
    if (incidr(n, selfs) && !force) { rej = rej "|" hp " self-needs-force"; next }
    ok = ok "," x[1] ":" port
}
END { sub(/^,/, "", ok); sub(/^\|/, "", rej); print ok; print rej }
