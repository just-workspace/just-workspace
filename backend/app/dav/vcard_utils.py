"""vCard serialization / deserialization."""

import base64
import json

import vobject
import vobject.vcard


def contact_to_vcard(c) -> str:
    """Convert a ContactDB row to a vCard 3.0 string."""
    v = vobject.vCard()

    v.add("fn").value = c.full_name or ""
    n = v.add("n")
    n.value = vobject.vcard.Name(
        family=c.surname or "",
        given=c.given_name or "",
    )
    v.add("uid").value = c.id

    if c.organization:
        v.add("org").value = [c.organization]

    for item_list, tag in (
        (c.emails, "email"),
        (c.phones, "tel"),
    ):
        if not item_list:
            continue
        try:
            items = json.loads(item_list) if isinstance(item_list, str) else item_list
        except (json.JSONDecodeError, TypeError):
            continue
        for entry in items:
            el = v.add(tag)
            el.value = entry.get("value", "")
            el.type_param = entry.get("type", "HOME").upper()

    if c.addresses:
        try:
            addrs = json.loads(c.addresses) if isinstance(c.addresses, str) else c.addresses
        except (json.JSONDecodeError, TypeError):
            addrs = []
        for addr in addrs:
            a = v.add("adr")
            a.value = vobject.vcard.Address(street=addr.get("value", ""))
            a.type_param = addr.get("type", "HOME").upper()

    if c.notes:
        v.add("note").value = c.notes

    # ── p4: 직함·그룹·사진 ──
    if getattr(c, "title", None):
        v.add("title").value = c.title
    groups = _json_list(getattr(c, "groups", None))
    if groups:
        v.add("categories").value = groups
    photo = getattr(c, "photo", None)
    if photo and photo.startswith("data:image/") and ";base64," in photo:
        head, b64 = photo.split(";base64,", 1)
        kind = head[len("data:image/"):].upper() or "JPEG"
        try:
            raw = base64.b64decode(b64)
            p = v.add("photo")
            p.value = raw
            p.encoding_param = "b"
            p.type_param = "JPEG" if kind in ("JPG", "JPEG") else kind
        except (ValueError, TypeError):
            pass

    if c.updated_at:
        v.add("rev").value = c.updated_at.strftime("%Y%m%dT%H%M%SZ")

    return v.serialize()


def _param_lower(obj, fallback="home") -> str:
    tp = getattr(obj, "type_param", None)
    if not tp:
        return fallback
    if isinstance(tp, str):
        return tp.lower()
    if isinstance(tp, list) and tp:
        return tp[0].lower()
    return fallback


def vcard_to_contact_data(vcard_text: str) -> dict | None:
    """Parse vCard text → dict of contact fields (or None on error)."""
    try:
        v = next(vobject.readComponents(vcard_text))
    except Exception:
        return None

    data: dict = {}

    uid = getattr(v, "uid", None)
    if uid:
        data["uid"] = uid.value

    fn = getattr(v, "fn", None)
    if fn:
        data["name"] = fn.value

    n = getattr(v, "n", None)
    if n:
        data["first_name"] = n.value.given or None
        data["last_name"] = n.value.family or None

    # vCard 는 연락처 전체다(CardDAV PUT = 통째 교체). 없는 항목도 빈 값으로 키를 넣는다 —
    # 예전엔 값이 있을 때만 키를 넣어, 휴대폰에서 전화번호·메모·소속을 지워도 서버에 남았다가 되살아났다.
    org = getattr(v, "org", None)
    data["organization"] = None
    if org:
        val = org.value
        if isinstance(val, list):
            data["organization"] = (val[0] if val else None) or None
        else:
            data["organization"] = str(val) if val else None

    data["emails"] = [
        {"type": _param_lower(em), "value": em.value}
        for em in v.contents.get("email", [])
    ]

    data["phones"] = [
        {"type": _param_lower(ph), "value": ph.value}
        for ph in v.contents.get("tel", [])
    ]

    addresses = []
    for adr in v.contents.get("adr", []):
        val = adr.value.street if hasattr(adr.value, "street") else str(adr.value)
        addresses.append({"type": _param_lower(adr), "value": val or ""})
    data["addresses"] = addresses

    note = getattr(v, "note", None)
    data["notes"] = (note.value or None) if note else None

    title = getattr(v, "title", None)
    data["title"] = title.value if title and title.value else None

    groups: list[str] = []
    for cat in v.contents.get("categories", []):
        val = cat.value
        for g in (val if isinstance(val, list) else str(val).split(",")):
            g = str(g).strip()
            if g and g not in groups:
                groups.append(g)
    data["groups"] = groups

    # 사진: 없으면 키를 넣지 않는다 — 사진을 빼고 보내는 클라이언트 때문에 기존 사진이 지워지지 않게
    photo = getattr(v, "photo", None)
    if photo is not None:
        uri = _photo_to_data_uri(photo)
        if uri:
            data["photo"] = uri

    return data


def _json_list(raw) -> list[str]:
    if not raw:
        return []
    try:
        val = json.loads(raw) if isinstance(raw, str) else raw
        return [str(x) for x in val] if isinstance(val, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def _photo_to_data_uri(photo) -> str | None:
    val = photo.value
    if isinstance(val, str):
        if val.startswith("data:image/"):
            return val
        if val.startswith(("http://", "https://")):
            return None  # 외부 URL 은 저장하지 않는다
        try:
            val = base64.b64decode(val)
        except (ValueError, TypeError):
            return None
    if not isinstance(val, (bytes, bytearray)) or not val:
        return None
    tp = getattr(photo, "type_param", None) or "JPEG"
    if isinstance(tp, list):
        tp = tp[0] if tp else "JPEG"
    kind = str(tp).lower().replace("image/", "")
    kind = "jpeg" if kind in ("jpg", "jpeg") else kind
    uri = f"data:image/{kind};base64," + base64.b64encode(bytes(val)).decode("ascii")
    return uri if len(uri) <= 700_000 else None
