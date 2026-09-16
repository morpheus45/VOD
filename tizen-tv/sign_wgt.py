#!/usr/bin/env python3
"""
sign_wgt.py — Signe un package Tizen .wgt avec W3C Widget Digital Signatures
Crée author-signature.xml + signature1.xml identiques à ceux de Tizen Studio.

────────────────────────────────────────────────────────────────────────────
IMPORTANT — pourquoi ce script ne génère PAS de certificat
────────────────────────────────────────────────────────────────────────────
Une TV Samsung ne regarde pas le contenu du certificat : elle valide la
CHAÎNE de certification du distributeur contre la CA racine Samsung.

Un certificat auto-signé (même avec le DUID de la TV dans le CN) est refusé
à l'installation avec :

    install failed[118019]
    → « Invalid certificate chain with certificate in signature »

Il faut donc un profil de certificats ÉMIS PAR SAMSUNG, créé dans
Tizen Studio → Tools → Certificate Manager → « + » → Samsung.
Ce profil produit deux fichiers :

    author.p12       ← certificat auteur
    distributor.p12  ← certificat distributeur, lié au DUID de la TV

et se trouve par défaut dans :

    Windows : C:\\Users\\<user>\\SamsungCertificate\\<profil>\\
    macOS   : ~/SamsungCertificate/<profil>/
    Linux   : ~/SamsungCertificate/<profil>/

Ces deux .p12 contiennent chacun la chaîne complète (feuille + intermédiaire
+ racine). C'est cette chaîne que ce script recopie dans les signatures.
────────────────────────────────────────────────────────────────────────────

Usage :
  python sign_wgt.py --input PIPSILY-TV.wgt --output PIPSILY-TV-signed.wgt \\
      --profile MonProfil --author-pass <mdp> --dist-pass <mdp>

  # ou en donnant les chemins explicitement
  python sign_wgt.py --input PIPSILY-TV.wgt --output PIPSILY-TV-signed.wgt \\
      --author-p12 .../author.p12 --author-pass <mdp> \\
      --dist-p12   .../distributor.p12 --dist-pass <mdp>
"""

import os, sys, zipfile, hashlib, base64, datetime, argparse, pathlib
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.hazmat.primitives.asymmetric import padding
from lxml import etree

DSI = "http://www.w3.org/2000/09/xmldsig#"
XA  = "http://uri.etsi.org/01903/v1.1.1#"
SHA256_URI = "http://www.w3.org/2001/04/xmlenc#sha256"
RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"
C14N       = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"

# Emplacement par défaut des profils créés par le Certificate Manager
SAMSUNG_CERT_DIR = pathlib.Path.home() / "SamsungCertificate"


def die(msg: str):
    print(f"ERREUR : {msg}", file=sys.stderr)
    sys.exit(1)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()

def sha256b64(data: bytes) -> str:
    return b64(hashlib.sha256(data).digest())


def load_p12(path: str, password: str, label: str):
    """
    Charge un .p12 (produit par le Certificate Manager) et renvoie
    (cle_privee, certificat_feuille, chaine_complete).

    `chaine_complete` = [feuille, intermédiaire..., racine] — c'est cette
    liste entière qui doit finir dans <X509Data>, sinon la TV rejette.
    """
    if not os.path.isfile(path):
        die(f"Certificat {label} introuvable : {path}")

    with open(path, "rb") as f:
        blob = f.read()

    try:
        key, cert, extras = pkcs12.load_key_and_certificates(
            blob, password.encode() if password else None
        )
    except Exception as e:
        die(f"Impossible d'ouvrir le certificat {label} ({path}) — "
            f"mot de passe incorrect ? [{e}]")

    if key is None or cert is None:
        die(f"Le certificat {label} ne contient pas de couple clé/certificat : {path}")

    chain = [cert] + list(extras or [])
    print(f"    {label:<12} : {cert.subject.rfc4514_string()}")
    print(f"    {'':<12}   chaine de {len(chain)} certificat(s)")

    if len(chain) < 2:
        print(f"    ATTENTION : le certificat {label} est seul dans sa chaine.")
        print(f"                S'il est auto-signe, la TV refusera (erreur 118019).")

    return key, cert, chain


def find_profile(name: str):
    """Retrouve author.p12 / distributor.p12 dans un profil Samsung standard."""
    base = SAMSUNG_CERT_DIR / name
    if not base.is_dir():
        die(f"Profil Samsung introuvable : {base}\n"
            f"       Le creer dans Tizen Studio -> Certificate Manager -> Samsung.")

    author = next(iter(sorted(base.glob("author*.p12"))), None)
    dist   = next(iter(sorted(base.glob("distributor*.p12"))), None)

    if not author or not dist:
        die(f"Le profil {base} ne contient pas author*.p12 et distributor*.p12")

    return str(author), str(dist)


def check_duid(dist_cert, duid: str):
    """Verifie que le certificat distributeur couvre bien le DUID de la TV."""
    if not duid:
        return

    haystack = dist_cert.subject.rfc4514_string()
    try:
        san = dist_cert.extensions.get_extension_for_class(x509.SubjectAlternativeName)
        haystack += " " + " ".join(str(v) for v in san.value)
    except x509.ExtensionNotFound:
        pass

    if duid.lower() in haystack.lower():
        print(f"    DUID {duid} present dans le certificat distributeur : OK")
    else:
        print(f"    ATTENTION : DUID {duid} ABSENT du certificat distributeur.")
        print(f"                Ce certificat a ete emis pour une autre TV,")
        print(f"                l'installation echouera.")


def _c14n(el: etree._Element) -> bytes:
    """Inclusive C14N of a single element."""
    import io
    stream = io.BytesIO()
    etree.ElementTree(el).write_c14n(stream, exclusive=False, with_comments=False)
    return stream.getvalue()


def build_signature(sig_id: str, refs: list, chain: list, key, signing_time: str) -> bytes:
    """
    Build a complete Signature XML element and return it as UTF-8 bytes.
    refs  = list of (uri, sha256_b64_digest)
    chain = [feuille, intermédiaire..., racine] — toute la chaîne part dans
            <X509Data>, c'est elle que la TV valide contre la CA Samsung.

    ── Deux pièges de canonicalisation, à ne pas réintroduire ──────────────
    1. Les digests (SignedProperties) et la signature (SignedInfo) doivent
       être calculés sur les éléments DÉJÀ rattachés à <Signature>. En C14N
       inclusive, l'élément de tête reçoit toutes les déclarations de
       namespace visibles ; un élément calculé détaché n'hérite pas du
       xmlns par défaut porté par <Signature> et produit d'autres octets.
    2. La sérialisation finale doit être sans pretty_print : l'indentation
       ajoute des nœuds texte à l'intérieur de SignedInfo, donc une
       canonicalisation différente de celle qui a été signée.
    Dans les deux cas la signature est syntaxiquement présente mais
    invalide, et la TV la rejette.
    """
    cert = chain[0]
    nsmap_ds = {None: DSI}

    # Racine d'abord : tout le reste est calculé une fois rattaché ici.
    sig_root = etree.Element(f"{{{DSI}}}Signature", Id=sig_id, nsmap=nsmap_ds)

    # ── Object / QualifyingProperties / SignedProperties ──────────────────────
    obj_el = etree.SubElement(sig_root, f"{{{DSI}}}Object", Id=f"{sig_id}Object")

    qp = etree.SubElement(obj_el, f"{{{XA}}}QualifyingProperties",
                          nsmap={"xades": XA, "ds": DSI},
                          Target=f"#{sig_id}")

    sp = etree.SubElement(qp, f"{{{XA}}}SignedProperties",
                          Id=f"{sig_id}SignedProperties")

    ssp = etree.SubElement(sp, f"{{{XA}}}SignedSignatureProperties")

    st = etree.SubElement(ssp, f"{{{XA}}}SigningTime")
    st.text = signing_time

    sc   = etree.SubElement(ssp,  f"{{{XA}}}SigningCertificate")
    c    = etree.SubElement(sc,   f"{{{XA}}}Cert")
    cd   = etree.SubElement(c,    f"{{{XA}}}CertDigest")
    cdm  = etree.SubElement(cd,   f"{{{DSI}}}DigestMethod",
                                  Algorithm=SHA256_URI)
    cdv  = etree.SubElement(cd,   f"{{{DSI}}}DigestValue")
    cdv.text = b64(cert.fingerprint(hashes.SHA256()))

    is_el = etree.SubElement(c,   f"{{{XA}}}IssuerSerial")
    xin   = etree.SubElement(is_el, f"{{{DSI}}}X509IssuerName")
    xin.text = cert.issuer.rfc4514_string()
    xsn   = etree.SubElement(is_el, f"{{{DSI}}}X509SerialNumber")
    xsn.text = str(cert.serial_number)

    # Canonicalize SignedProperties to compute its digest — sp est déjà
    # rattaché à <Signature>, donc dans le même contexte qu'à la vérification.
    sp_c14n  = _c14n(sp)
    sp_digest = sha256b64(sp_c14n)

    # ── SignedInfo ─────────────────────────────────────────────────────────────
    # Inséré en tête (l'ordre impose SignedInfo, SignatureValue, KeyInfo, Object)
    si = etree.Element(f"{{{DSI}}}SignedInfo", nsmap=nsmap_ds)
    sig_root.insert(0, si)

    cm = etree.SubElement(si, f"{{{DSI}}}CanonicalizationMethod", Algorithm=C14N)
    sm = etree.SubElement(si, f"{{{DSI}}}SignatureMethod",         Algorithm=RSA_SHA256)

    for uri, digest in refs:
        ref = etree.SubElement(si, f"{{{DSI}}}Reference", URI=uri)
        dm  = etree.SubElement(ref, f"{{{DSI}}}DigestMethod", Algorithm=SHA256_URI)
        dv  = etree.SubElement(ref, f"{{{DSI}}}DigestValue")
        dv.text = digest

    # Reference for SignedProperties
    sp_ref = etree.SubElement(si, f"{{{DSI}}}Reference",
                              Type=f"{XA}SignedProperties",
                              URI=f"#{sig_id}SignedProperties")
    sp_ref_dm = etree.SubElement(sp_ref, f"{{{DSI}}}DigestMethod", Algorithm=SHA256_URI)
    sp_ref_dv = etree.SubElement(sp_ref, f"{{{DSI}}}DigestValue")
    sp_ref_dv.text = sp_digest

    # Sign c14n(SignedInfo)
    si_c14n = _c14n(si)
    sig_val  = b64(key.sign(si_c14n, padding.PKCS1v15(), hashes.SHA256()))

    # ── SignatureValue + KeyInfo, entre SignedInfo et Object ──────────────────
    sv_el = etree.Element(f"{{{DSI}}}SignatureValue")
    sv_el.text = sig_val
    sig_root.insert(1, sv_el)

    ki     = etree.Element(f"{{{DSI}}}KeyInfo")
    x9data = etree.SubElement(ki,       f"{{{DSI}}}X509Data")
    for link in chain:
        x9cert = etree.SubElement(x9data, f"{{{DSI}}}X509Certificate")
        x9cert.text = b64(link.public_bytes(serialization.Encoding.DER))
    sig_root.insert(2, ki)

    # pretty_print=False : voir la note en tête de fonction.
    return etree.tostring(sig_root, pretty_print=False,
                          xml_declaration=True, encoding="UTF-8")


def sign_wgt(wgt_in: str, wgt_out: str,
             author_p12: str, author_pass: str,
             dist_p12: str,   dist_pass: str,
             duid: str = ""):

    print("[1/4] Chargement des certificats Samsung...")
    author_key, author_cert, author_chain = load_p12(author_p12, author_pass, "auteur")
    dist_key,   dist_cert,   dist_chain   = load_p12(dist_p12,   dist_pass,   "distributeur")
    check_duid(dist_cert, duid)

    signing_time = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    print(f"[2/4] Lecture du WGT : {wgt_in}")
    with zipfile.ZipFile(wgt_in, "r") as zf:
        names = sorted(
            n for n in zf.namelist()
            if n not in ("author-signature.xml", "signature1.xml")
        )
        if any(n.startswith('/') or '..' in n for n in names):
            die("entrées zip invalides détectées (path traversal)")
        contents = {n: zf.read(n) for n in names}

    refs = [(n, sha256b64(contents[n])) for n in names]
    print(f"    {len(names)} fichiers a signer")

    print("[3/4] Creation author-signature.xml (certificat auteur)...")
    author_xml = build_signature("AuthorSignature", refs,
                                 author_chain, author_key, signing_time)

    print("[3/4] Creation signature1.xml (certificat distributeur)...")
    dist_refs  = refs + [("author-signature.xml", sha256b64(author_xml))]
    dist_xml   = build_signature("DistributorSignature", dist_refs,
                                 dist_chain, dist_key, signing_time)

    print(f"[4/4] Ecriture WGT signe : {wgt_out}")
    with zipfile.ZipFile(wgt_out, "w", zipfile.ZIP_DEFLATED) as zf:
        for n in names:
            zf.writestr(n, contents[n])
        zf.writestr("author-signature.xml", author_xml)
        zf.writestr("signature1.xml", dist_xml)

    size = os.path.getsize(wgt_out) / 1024
    print(f"\nSUCCES — WGT signe ({size:.0f} Ko)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Signe un .wgt Tizen avec un profil de certificats Samsung",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Le profil se cree dans Tizen Studio -> Certificate Manager -> Samsung.\n"
               "Un certificat auto-signe est refuse par la TV (erreur 118019).")
    parser.add_argument("--input",       required=True, help="Chemin du .wgt non-signe (PIPSILY-TV.wgt)")
    parser.add_argument("--output",      required=True, help="Chemin du .wgt signe en sortie")
    parser.add_argument("--profile",     default=None,  help=f"Nom du profil dans {SAMSUNG_CERT_DIR}")
    parser.add_argument("--author-p12",  default=None,  help="Chemin explicite du author.p12")
    parser.add_argument("--dist-p12",    default=None,  help="Chemin explicite du distributor.p12")
    parser.add_argument("--author-pass", default="",    help="Mot de passe du author.p12")
    parser.add_argument("--dist-pass",   default="",    help="Mot de passe du distributor.p12")
    parser.add_argument("--duid",        default="",    help="Optionnel : DUID de la TV, pour verifier que le certificat lui correspond")
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        die(f"fichier introuvable : {args.input}")

    author_p12, dist_p12 = args.author_p12, args.dist_p12
    if args.profile:
        author_p12, dist_p12 = find_profile(args.profile)
    if not author_p12 or not dist_p12:
        die("il faut --profile <nom>, ou bien --author-p12 ET --dist-p12.\n"
            "       Ces fichiers sont produits par Tizen Studio :\n"
            "       Tools -> Certificate Manager -> « + » -> Samsung.\n"
            "       Sans eux, la TV refuse le package (erreur 118019).")

    sign_wgt(args.input, args.output,
             author_p12, args.author_pass,
             dist_p12,   args.dist_pass,
             duid=args.duid)
