"""Per-user content lock ("privacy vault").

A generic primitive: a user sets a numeric PIN; endpoints that expose private
content call ``gate.is_unlocked(request, user)`` and hide the content when it
returns False. Unlock is stateless and server-enforced — see ``gate.py``.
"""
