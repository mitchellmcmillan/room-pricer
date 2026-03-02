import React, { useState } from "react";

export default function RoomCircle({
    name = "Room 1",
    description = "Ground floor",
    price = "£605",
    numPeople = 0,
    emoji = "🛏️",
    animate = false,
    onSelect,
    isSelected = false,
    canSelect = true,
    progress,
}) {
    const getCircleStyles = (numPeople) => {
        if (numPeople === 0) {
            return {
                border: "4px solid #ccc",
                background: "#fff",
                color: "#333",
            };
        } else if (numPeople === 1) {
            return {
                border: "4px solid #4caf50",
                background: "#e8f5e9",
                color: "#333",
            };
        } else {
            return {
                border: "4px solid #f44336",
                background: "#ffebee",
                color: "#333",
            };
        }
    };

    const [hovered, setHovered] = useState(false);
    const styles = getCircleStyles(numPeople);
    // Minor darken background color on hover
    function darkenColor(hex, amount = 6) {
        hex = hex.replace('#', '');
        if (hex.length === 3) hex = hex.split('').map(x => x + x).join('');
        let r = parseInt(hex.substring(0, 2), 16);
        let g = parseInt(hex.substring(2, 4), 16);
        let b = parseInt(hex.substring(4, 6), 16);
        r = Math.max(0, r - amount);
        g = Math.max(0, g - amount);
        b = Math.max(0, b - amount);
        return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
    }
    const size = 200;
    const strokeWidth = 6;
    const radius = (size / 2) - (strokeWidth / 2);
    const circumference = 2 * Math.PI * radius;
    // --- Remove internal progress animation ---
    // Use progress prop directly
    const progressValue = typeof progress === 'number' ? progress : 0;
    const offset = circumference * (1 - progressValue);
    // Choose colors based on numPeople
    let ringColor = '#e0e0e0'; // lighter grey
    let progressColor = '#888'; // darker grey
    if (numPeople === 1) {
        ringColor = '#a5d6a7'; // lighter green
        progressColor = '#43a047'; // slightly lighter green
    } else if (numPeople > 1) {
        ringColor = '#ffcdd2'; // lighter red
        progressColor = '#e53935'; // slightly lighter red
    }
    // Increase padding to ensure marker is fully visible
    return (
        <div
            style={{
                position: "relative",
                width: size + strokeWidth * 2,
                height: size + strokeWidth * 2,
                padding: strokeWidth,
                boxSizing: 'content-box',
                outline: isSelected ? '3px solid #1976d2' : 'none',
                cursor: canSelect ? 'pointer' : 'default',
            }}
            onClick={e => {
                if (canSelect && onSelect) onSelect(e);
            }}
        >
            <div
                style={{
                    ...styles,
                    background: hovered ? darkenColor(styles.background, 6) : styles.background,
                    borderRadius: "50%",
                    width: size,
                    height: size,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "flex-start",
                    padding: 0,
                    boxSizing: "border-box",
                    fontFamily: "sans-serif",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
                    position: "relative",
                    zIndex: 1,
                }}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
            >
                <div
                    style={{
                        fontWeight: "bold",
                        fontSize: 28,
                        height: "30%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "100%",
                        margin: 0,
                        padding: 0,
                        paddingTop: "7.5%",
                        paddingBottom: 0,
                    }}
                >
                    {name}
                </div>
                <div
                    style={{
                        fontSize: 40,
                        height: "15%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "100%"
                    }}
                >
                    {emoji}
                </div>
                <div
                    style={{
                        fontSize: 16,
                        textAlign: "center",
                        height: "15%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "100%",
                    }}
                >
                    {description}
                </div>
                <div
                    style={{
                        fontSize: 18,
                        fontWeight: "bold",
                        height: "15%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "100%",
                    }}
                >
                    {price}
                </div>
                <div
                    style={{
                        fontSize: 18,
                        fontWeight: "bold",
                        height: "15%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "100%",
                        position: "absolute",
                        bottom: 0,
                        left: 0,
                        paddingBottom: "2.5%"
                    }}
                >
                    {numPeople}/1
                </div>
            </div>
            {
                animate && numPeople !== 1 && progressValue < 1 && (
                    <svg width={size} height={size} style={{ position: "absolute", top: strokeWidth, left: strokeWidth, zIndex: 10, pointerEvents: "none", overflow: 'visible' }}>
                        {/* Background ring */}
                        <circle
                            cx={size / 2}
                            cy={size / 2}
                            r={radius}
                            stroke={ringColor}
                            strokeWidth={strokeWidth}
                            fill="none"
                        />
                        {/* Progress ring - rotate -90deg to start at 12 o'clock */}
                        <circle
                            cx={size / 2}
                            cy={size / 2}
                            r={radius}
                            stroke={progressColor}
                            strokeWidth={strokeWidth}
                            fill="none"
                            strokeDasharray={circumference}
                            strokeDashoffset={offset}
                            style={{
                                transition: "none",
                                transform: "rotate(-90deg)",
                                transformOrigin: "50% 50%"
                            }}
                        />
                    </svg>
                )
            }
        </div >
    );
}
