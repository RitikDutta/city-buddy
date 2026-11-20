"use client";
import Link from "next/link";
import { Compass, Globe2, MapPin } from "lucide-react";
import { modes, modeInfo } from "@/lib/contracts";
import { LocationForm, Sources } from "./location-form";
import { modeArt, modeIcons } from "./ui";
import { useWorkspace } from "./workspace";
import { SessionRows } from "./sessions";

export function Overview() {
  const { data, changeLocation } = useWorkspace();
  const recent =
    data?.sessions.filter((s) => s.message_count > 0).slice(0, 3) ?? [];
  return (
    <div className="overview">
      <section className="hero" aria-label="CityBuddy introduction">
        <img
          className="hero-art"
          src="/art/jaipur.webp"
          alt="Travel illustration of Jaipur’s Hawa Mahal, rooftops, and hills"
          fetchPriority="high"
        />
        <div className="hero-copy">
          <div className="eyebrow">
            <span />
            CityBuddy
          </div>
          <h1>
            Your City.
            <br />
            <em>Your AI Companion.</em>
          </h1>
        </div>
        <span className="art-caption">
          <MapPin size={12} /> Hawa Mahal, Jaipur
        </span>
      </section>
      {data?.location ? (
        <section className="panel location-panel" aria-label="Current location">
          <div className="selected-location">
            <span className="location-symbol">
              <MapPin size={22} />
            </span>
            <div>
              <small>Current location</small>
              <h2>{data.location.name}</h2>
              {data.location.formatted_address && (
                <p>{data.location.formatted_address}</p>
              )}
            </div>
            <button className="secondary" onClick={changeLocation}>
              Change Location
            </button>
          </div>
          <Sources values={data.location.sources} />
        </section>
      ) : (
        <LocationForm />
      )}
      <section className="mode-section" aria-labelledby="modes-heading">
        <div className="section-heading">
          <h2 id="modes-heading">Explore your city</h2>
        </div>
        <div className="mode-grid">
          {modes.map((m) => {
            const Icon = modeIcons[m];
            return (
              <Link
                key={m}
                href={modeInfo[m].path}
                className={"mode-card " + m}
              >
                <div className="card-image">
                  <img src={modeArt[m]} alt="" />
                </div>
                <div className="card-copy">
                  <div className="card-title">
                    <span className="mode-icon">
                      <Icon size={19} />
                    </span>
                    <h3>{modeInfo[m].name}</h3>
                  </div>
                  <p>{modeInfo[m].description}</p>
                </div>
              </Link>
            );
          })}
        </div>
      </section>
      {recent.length > 0 && (
        <section>
          <div className="section-heading">
            <h2>Recent sessions</h2>
            <Link href="/history" className="text-button">
              View history
            </Link>
          </div>
          <SessionRows sessions={recent} />
        </section>
      )}
      <footer className="home-footer">
        <span>
          <Globe2 size={15} /> English · हिन्दी · Hinglish
        </span>
        <span>
          <Compass size={15} /> Powered by Gemini &amp; Google Maps
        </span>
      </footer>
    </div>
  );
}
