"""Keyword-based academic paper classifier.

Assigns papers to categories based on title + abstract content using
weighted keyword matching. Categories are designed to reflect common
academic disciplines found in scholarly paper databases.
"""
import re

# Each category has a list of (weight, pattern) tuples.
# Patterns are compiled case-insensitive. Higher weight = stronger signal.
_TAXONOMY: dict[str, list[tuple[float, str]]] = {
    "Quantum Physics": [
        (3.0, r"\bquantum\b"),
        (2.0, r"\bqubit"),
        (2.0, r"\bentangle"),
        (2.0, r"\bsuperposition\b"),
        (1.5, r"\bspin.?orbit\b"),
        (1.5, r"\btopological\s+(insulator|order|phase|material)"),
        (1.5, r"\bquantum\s+(computing|information|simulation|error|circuit|gate|algorithm)"),
        (1.0, r"\bBose.?Einstein\b"),
        (1.0, r"\bfermion"),
        (1.0, r"\bboson"),
        (1.0, r"\bHilbert\s+space"),
        (1.0, r"\bwave\s*function"),
    ],
    "Condensed Matter Physics": [
        (3.0, r"\bcondensed\s+matter\b"),
        (2.5, r"\bsuperconducti"),
        (2.0, r"\bsuperconductor"),
        (2.0, r"\bferromagnet"),
        (2.0, r"\bantiferromagnet"),
        (2.0, r"\bferrimagnet"),
        (1.5, r"\bmagnetic\s+order"),
        (1.5, r"\bspin.?density\s+wave"),
        (1.5, r"\bvan\s+der\s+Waals"),
        (1.5, r"\bphonon"),
        (1.5, r"\bLandau\b"),
        (1.5, r"\bHall\s+(effect|conductiv)"),
        (1.0, r"\blattice\s+(dynamics|vibration|constant)"),
        (1.0, r"\bthin\s+film"),
        (1.0, r"\bmagneto"),
    ],
    "Optics & Photonics": [
        (3.0, r"\bdiode\s+laser"),
        (3.0, r"\bphotonic"),
        (2.5, r"\bexternal.?cavity\b"),
        (2.0, r"\blaser\s+(diode|system|beam|pulse|field|spectroscop|stabiliz|frequency|emission|output)"),
        (2.0, r"\blight.?emitting\s+diode"),
        (2.0, r"\b(LED|LEDs)\b"),
        (1.5, r"\boptical\s+(cavity|injection|feedback|trap|spectroscop|imaging|resonat)"),
        (1.5, r"\bwavelength\b"),
        (1.5, r"\binterferenc"),
        (1.0, r"\bsoliton"),
        (1.0, r"\bnonlinear\s+optic"),
        (1.0, r"\bholographic"),
        (1.0, r"\bfiber\s+laser"),
    ],
    "Plasma & Fusion Physics": [
        (3.0, r"\bfusion\s+(reactor|energy|plasma|ignition|device)"),
        (3.0, r"\btokamak"),
        (2.5, r"\bMHD\b"),
        (2.5, r"\bplasma\s+(physics|density|instabilit|heating|confinement)"),
        (2.0, r"\bmagnetohydrodynamic"),
        (2.0, r"\bdivertor\b"),
        (1.5, r"\bproton\s+acceler"),
        (1.5, r"\bion\s+acceler"),
    ],
    "Particle & Nuclear Physics": [
        (3.0, r"\bneutrino"),
        (3.0, r"\bhadron"),
        (2.5, r"\bhigh.?energy\s+physics"),
        (2.0, r"\bparticle\s+(physics|acceler|collid)"),
        (2.0, r"\bquark"),
        (2.0, r"\bHiggs\b"),
        (1.5, r"\bstandard\s+model\b"),
        (1.5, r"\bdark\s+matter"),
        (1.5, r"\bMajorana\b"),
    ],
    "Education & Pedagogy": [
        (3.0, r"\bteaching\s+(and\s+learning|media|method|strateg|device|trigonometr|mathematic)"),
        (3.0, r"\bstudent\w*\s+(error|difficult|misconception|performance|perception|worksheet)"),
        (2.5, r"\bpedagog"),
        (2.5, r"\blearning\s+(module|media|outcome|motivation|process|kit)"),
        (2.0, r"\bclassroom\b"),
        (2.0, r"\bcurriculum"),
        (2.0, r"\binstructional\b"),
        (2.0, r"\btutoring\b"),
        (2.0, r"\beducation\w*\s+(research|reform|system|context)"),
        (2.0, r"\bGeoGebra\b"),
        (2.0, r"\bconstructivis"),
        (1.5, r"\bunderachiev"),
        (1.5, r"\bproblem.?solving\s+(strategy|skill|ability)"),
        (1.5, r"\btextbook"),
        (1.5, r"\bworksheet"),
        (1.0, r"\bschool\s+student"),
        (1.0, r"\bmath\w*\s+(education|teacher|concept|skill)"),
    ],
    "Engineering": [
        (3.0, r"\bhardware.?software\s+codesign"),
        (2.5, r"\bfinite\s+element"),
        (2.0, r"\bperidynamic"),
        (2.0, r"\brheolog"),
        (2.0, r"\badditive\s+manufactur"),
        (2.0, r"\b3D\s+print"),
        (2.0, r"\bphase\s+field\s+model"),
        (1.5, r"\bnonlinear\s+(dynamics|material|behavior)"),
        (1.5, r"\bstructural\s+(analysis|engineer|mechanic)"),
        (1.5, r"\bcomputational\s+(mechanic|fluid|model)"),
        (1.5, r"\bwork\s+zone"),
        (1.5, r"\bconnected\s+(automated|vehicle)"),
        (1.0, r"\btensor\b.*\b(mechanic|stress|strain)"),
        (1.0, r"\bmanufactur"),
        (1.0, r"\bangular\s+(momentum|velocity)"),
    ],
    "Astrophysics & Astronomy": [
        (3.0, r"\bexoplanet"),
        (2.5, r"\bastrophysic"),
        (2.0, r"\bcosmolog"),
        (2.0, r"\bstellar\b"),
        (2.0, r"\bgalaxy|galaxies"),
        (2.0, r"\bnebula"),
        (1.5, r"\bplanetary\b"),
        (1.5, r"\bcelestial"),
        (1.5, r"\bhabitable\s+zone"),
        (1.5, r"\bsnowball\s+state"),
        (1.0, r"\bsolar\s+(system|wind|flare)"),
        (1.0, r"\bclimate\s+model.*planet"),
    ],
    "Materials Science": [
        (3.0, r"\bmaterials?\s+science"),
        (2.5, r"\b(2D|two.?dimensional)\s+material"),
        (2.5, r"\bmultiferroic"),
        (2.0, r"\bnanoparticle"),
        (2.0, r"\bnanostructur"),
        (2.0, r"\bthin\s+film"),
        (2.0, r"\bspintronics"),
        (2.0, r"\bphotostrictive"),
        (2.0, r"\brefractive\s+index"),
        (2.0, r"\bNernst\b"),
        (1.5, r"\bcomposit\w+\s+(material|graded|film)"),
        (1.5, r"\bcrystal\s+(structure|growth|symmetry)"),
        (1.5, r"\balloy"),
        (1.5, r"\bpolymer"),
        (1.5, r"\bceramic"),
        (1.5, r"\bplasmonic"),
        (1.5, r"\boctahedral\s+rotation"),
        (1.5, r"\bgraphene"),
        (1.5, r"\bMoS.?2\b"),
        (1.0, r"\bdielectric"),
        (1.0, r"\bmicrostructur"),
        (1.0, r"\bmorpholog"),
        (1.0, r"\bwettabilit"),
        (1.0, r"\bband\s+gap"),
    ],
    "Chemistry": [
        (3.0, r"\bchemical\s+(reaction|synthesis|compound|composition|engineer|design|dynamics|physics|potential|sensor|yield|route|reacto)"),
        (2.5, r"\bchemistry\b"),
        (2.0, r"\bmolecul\w+\s+(dynamics|simulation|structure|orbital|similarity)"),
        (2.0, r"\bcatalys"),
        (2.0, r"\belectrochemi"),
        (2.0, r"\belectrolysis"),
        (2.0, r"\bdecarbonization"),
        (2.0, r"\bsemiempirical\s+electron"),
        (2.0, r"\bDFT\b|density.?functional"),
        (2.0, r"\bequation\s+of\s+state"),
        (1.5, r"\breaction\s+(mechanism|kinetic|rate|pathway)"),
        (1.5, r"\bsynthesis\b"),
        (1.5, r"\bthermodynamic"),
        (1.5, r"\bwavefunction"),
        (1.5, r"\bchemical\s+space"),
        (1.0, r"\bsolvent"),
        (1.0, r"\bspectroscop\w+\s+(analysis|technique|measurement)"),
        (1.0, r"\bstoichiometr"),
        (1.0, r"\bisospin\b"),
        (1.0, r"\bbaryon\b"),
    ],
    "Geoscience": [
        (3.0, r"\bgeolog"),
        (3.0, r"\bvolcanic\b"),
        (2.5, r"\bmineral\s+(composition|assembl|character)"),
        (2.5, r"\bsediment"),
        (2.0, r"\bgeochemi"),
        (2.0, r"\btectonic"),
        (2.0, r"\bvolcano"),
        (1.5, r"\bite\b.*mineral"),
        (1.5, r"\bite\b.*rock"),
        (1.5, r"\bash\b.*volcan"),
        (1.0, r"\bite\b.*ore\b"),
        (1.0, r"\bite\b.*calc"),
        (1.0, r"\bignimbrite"),
        (1.0, r"\bite\b.*fluorescence"),
    ],
    "Biology & Life Sciences": [
        (3.0, r"\bbiolog"),
        (2.5, r"\bgenomic"),
        (2.5, r"\bbioinformatic"),
        (2.0, r"\bprotein\b"),
        (2.0, r"\bcell\s+(biology|division|signaling|membrane)"),
        (2.0, r"\bgene\s+(expression|regulation|sequenc)"),
        (2.0, r"\bsequence\s+(alignment|homolog|similar)"),
        (2.0, r"\bmultiple\s+sequence"),
        (1.5, r"\becolog"),
        (1.5, r"\bevolution\w*\s+(biology|selection|adaptation|genetic|theor)"),
        (1.5, r"\bphylogenet"),
        (1.5, r"\bcell\s+phenotyp"),
        (1.5, r"\bbiomarker"),
        (1.0, r"\bspecies\b"),
        (1.0, r"\bbiodiversit"),
        (1.0, r"\bphenotyp"),
        (1.0, r"\bfluorescen"),
    ],
    "Medicine & Health Sciences": [
        (3.0, r"\bclinical\s+trial"),
        (2.5, r"\bpatholog"),
        (2.0, r"\btherapeutic"),
        (2.0, r"\bdrug\s+(discovery|delivery|target|resist)"),
        (2.0, r"\bdiagnosti"),
        (1.5, r"\bepidemiolog"),
        (1.5, r"\bcardiac\b"),
        (1.5, r"\btumor|tumour"),
        (1.5, r"\bcancer\b"),
        (1.0, r"\bpatient"),
        (1.0, r"\boncolog"),
    ],
    "Food Science & Toxicology": [
        (3.0, r"\bmycotoxin"),
        (3.0, r"\baflatoxin"),
        (2.5, r"\bfood\s+(safety|contamin|quality|science)"),
        (2.0, r"\btoxicolog"),
        (1.5, r"\bfoodborne"),
        (1.5, r"\bcereal|grain|maize|wheat"),
    ],
    "Machine Learning & AI": [
        (3.0, r"\bmachine\s+learning"),
        (3.0, r"\bdeep\s+learning"),
        (2.5, r"\bneural\s+network"),
        (2.5, r"\bartificial\s+intelligence"),
        (2.0, r"\breinforcement\s+learning"),
        (2.0, r"\bnatural\s+language\s+processing"),
        (2.0, r"\bcomputer\s+vision"),
        (2.0, r"\btransformer\s+(model|architect|attention)"),
        (2.0, r"\bLLM\b|language\s+model"),
        (1.5, r"\bGAN\b|generative\s+adversarial"),
        (1.5, r"\bconvolution"),
        (1.5, r"\bclassif\w+\s+(model|algorithm|task)"),
        (1.5, r"\bgenetic\s+algorithm"),
        (1.5, r"\bCNN\b|convolutional\s+neural"),
        (1.0, r"\bsupervised\s+learning"),
        (1.0, r"\bgraph\s+(neural|contrastive|network|learn)"),
        (1.0, r"\bimage\s+(recognition|segmentation|classification)"),
    ],
    "Computer Science": [
        (2.5, r"\balgorithm\s+(design|complexity|analysis|optim)"),
        (2.0, r"\bcryptograph"),
        (2.0, r"\bdistributed\s+system"),
        (2.0, r"\bsoftware\s+(engineering|architect|system|development)"),
        (2.0, r"\binformation\s+technology"),
        (1.5, r"\bautonomous\s+(vehicle|driving|system)"),
        (1.5, r"\brobotic"),
        (1.5, r"\bblock\s*chain"),
        (1.5, r"\bcloud\s+computing"),
        (1.5, r"\bAndroid\b.*\b(app|librar|API)"),
        (1.5, r"\buser\s+(research|interface|experience|study)"),
        (1.5, r"\bsequence\s+alignment"),
        (1.5, r"\bHMM\b.*search"),
        (1.0, r"\bdata\s+(structure|mining|science)"),
        (1.0, r"\bcybersecurit"),
        (1.0, r"\bopen.?source\b"),
        (1.0, r"\bAPI\b"),
        (1.0, r"\bweb\s+(service|application|platform)"),
    ],
    "Mathematics": [
        (3.0, r"\btrigonometr"),
        (3.0, r"\bnumber\s+theory"),
        (2.5, r"\btopolog\w+\s+(invariant|space|manifold)"),
        (2.5, r"\bgeometr\w+\s+(proof|construction|problem|approach|model|space)"),
        (2.5, r"\bhyperbolic\s+(geometry|trigonometr|space|plane)"),
        (2.5, r"\bspherical\s+(geometry|trigonometr)"),
        (2.5, r"\beuclidean\s+(geometry|space)"),
        (2.0, r"\bconjecture"),
        (2.0, r"\balgebraic\s+(geometry|structure|topology)"),
        (2.0, r"\bstochastic\b"),
        (2.0, r"\bpolygon"),
        (2.0, r"\btetrahedr"),
        (2.0, r"\bisoperimetric"),
        (2.0, r"\bsine|cosine|tangent"),
        (1.5, r"\basymptotic"),
        (1.5, r"\bRiemann"),
        (1.5, r"\bHilbert\b"),
        (1.5, r"\bLorentzian\b"),
        (1.5, r"\bLobachevsky"),
        (1.5, r"\bEuler\b.*\b(formula|work|theorem)"),
        (1.5, r"\blinear\s+algebra"),
        (1.5, r"\bcalculus\b"),
        (1.5, r"\bPoincar"),
        (1.0, r"\belliptic\s+(curve|function)"),
        (1.0, r"\bmodular\s+form"),
        (1.0, r"\bdensity\s+zero\b.*\bprime"),
        (1.0, r"\bprojectiv\w+\s+(geometry|space|plane)"),
        (1.0, r"\bgeodesic"),
        (1.0, r"\bChebyshev"),
    ],
    "Scientometrics & Research Policy": [
        (3.0, r"\bscientometric"),
        (3.0, r"\bbibliometric"),
        (2.5, r"\bresearch\s+(ethics|policy|output|impact|behaviour|governance|methodology|career|productivity|compendium)"),
        (2.0, r"\bpublication\s+(bias|practice|pattern|record)"),
        (2.0, r"\bpeer\s+review"),
        (2.0, r"\beducation\s+research"),
        (2.0, r"\bphysics\s+(education|faculty)"),
        (2.0, r"\bcitation\s+(count|index|normali)"),
        (1.5, r"\bacademic\s+(research|integrity|career)"),
        (1.5, r"\bopen\s+access"),
        (1.5, r"\bresponsible\s+(computing|research)"),
        (1.5, r"\binterdisciplinary\s+research"),
        (1.5, r"\bdigital\s+well.?being"),
        (1.0, r"\bconference\s+(submission|review)"),
    ],
}

# Compile patterns once
_COMPILED: dict[str, list[tuple[float, re.Pattern]]] = {}
for _cat, _patterns in _TAXONOMY.items():
    _COMPILED[_cat] = [(w, re.compile(p, re.IGNORECASE)) for w, p in _patterns]


def classify_paper(title: str, abstract: str = "") -> str:
    """Classify a paper into an academic category based on title + abstract.

    Uses weighted keyword matching against a predefined taxonomy.
    Returns the best-matching category, or "Other" if no category
    scores above the threshold.

    Args:
        title: Paper title.
        abstract: Paper abstract (optional but improves accuracy).

    Returns:
        Category string (e.g. "Quantum Physics", "Materials Science").
    """
    text = f"{title} {abstract}"
    if not text.strip():
        return "Other"

    scores: dict[str, float] = {}
    for cat, patterns in _COMPILED.items():
        score = 0.0
        for weight, rx in patterns:
            matches = rx.findall(text)
            if matches:
                # Diminishing returns for multiple matches of same pattern
                score += weight * (1 + 0.3 * (len(matches) - 1))
        scores[cat] = score

    best_cat = max(scores, key=scores.get)  # type: ignore[arg-type]
    best_score = scores[best_cat]

    # Require a minimum score to avoid weak classifications
    if best_score < 1.0:
        return "Other"

    return best_cat
