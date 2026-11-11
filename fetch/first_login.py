"""התחברות ראשונה (מטפל גם בקוד אימות דו-שלבי) ומדפיס את GARMIN_TOKENS להדבקה ב-Secrets."""
import getpass
from garminconnect import Garmin

email = input("אימייל של Garmin: ").strip()
pw = getpass.getpass("סיסמת Garmin: ")
g = Garmin(email, pw, prompt_mfa=lambda: input("קוד אימות (MFA): ").strip())
g.login()
print("\nהעתק את כל השורה הבאה ל-Secret בשם GARMIN_TOKENS:\n")
print(g.client.dumps())
