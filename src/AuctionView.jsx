import React from "react";
import RoomCircle from "./RoomCircle";
import PersonSelection from "./PersonSelection";

export default function AuctionView({
    people,
    roomNames,
    roomDescriptions,
    stage,
    selectedPerson,
    roomPrices,
    roomSelections,
    userRoom,
    auctionStartTime,
    smoothProgress,
    allocationFound,
    nextTickChanges,
    onPersonSelect,
    onRoomSelect,
    chosenPeople,
    allRoomsSelected,
    readyUI // <-- new prop for ready button/message
}) {
    // PersonSelection stage
    if (stage === "select") {
        return (
            <div style={{ minHeight: 500, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start' }}>
                <PersonSelection
                    people={people}
                    onSelect={onPersonSelect}
                    selectedIdx={selectedPerson}
                    chosenPeople={chosenPeople}
                />
            </div>
        );
    }

    return (
        <div style={{ width: '100%', padding: 32, minHeight: 500, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', boxSizing: 'border-box' }}>
            <div style={{ display: "flex", width: '100%', gap: 24, justifyContent: 'center', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                {roomNames.map((room, idx) => (
                    <div
                        key={room}
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            minHeight: 260,
                            overflow: "visible",
                        }}
                    >
                        <div style={{ minHeight: 28, marginBottom: 4 }}>
                            {nextTickChanges && nextTickChanges[idx] < 0 && (
                                <span style={{ color: '#888', fontWeight: 'bold', fontSize: 18 }}>
                                    -£{Math.abs(nextTickChanges[idx])}
                                </span>
                            )}
                            {nextTickChanges && nextTickChanges[idx] === 0 && (
                                <span style={{ color: '#43a047', fontWeight: 'bold', fontSize: 18 }}>
                                    -
                                </span>
                            )}
                            {nextTickChanges && nextTickChanges[idx] > 0 && (
                                <span style={{ color: '#d32f2f', fontWeight: 'bold', fontSize: 18 }}>
                                    +£{nextTickChanges[idx]}
                                </span>
                            )}
                        </div>
                        <RoomCircle
                            name={room}
                            description={roomDescriptions[idx]}
                            price={`£${roomPrices[idx]}`}
                            numPeople={roomSelections[idx].length}
                            progress={auctionStartTime ? smoothProgress : 0}
                            animate={!!auctionStartTime}
                            onSelect={() => {
                                if (selectedPerson !== null && userRoom !== idx) {
                                    onRoomSelect(idx);
                                }
                            }}
                            canSelect={selectedPerson !== null && userRoom !== idx}
                            isSelected={userRoom === idx}
                            style={{ cursor: "pointer" }}
                        />
                        <div
                            style={{
                                display: "flex",
                                flexDirection: "row",
                                alignItems: "center",
                                marginTop: 8,
                                gap: 4,
                                overflow: "visible",
                                minHeight: 40,
                            }}
                        >
                            {roomSelections[idx].map((i) => (
                                <span key={i} style={{ fontSize: 32 }}>
                                    {people[i].emoji}
                                </span>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
            {/* Hide waiting message if allRoomsSelected is true, reserve space for message */}
            <div style={{ minHeight: 32, marginTop: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {!auctionStartTime && !allRoomsSelected && people.length > 0 && (
                    <span style={{ fontSize: 18, color: '#888' }}>
                        Waiting for all {people.length} {people.length === 1 ? 'player' : 'players'} to select a room...
                    </span>
                )}
                {!auctionStartTime && !allRoomsSelected && people.length === 0 && (
                    <span style={{ fontSize: 18, color: '#888' }}>
                        Waiting for roster to load...
                    </span>
                )}
                {allocationFound && (
                    <span style={{ fontSize: 22, color: '#43a047', fontWeight: 'bold' }}>
                        Allocation found!
                    </span>
                )}
            </div>
            {/* Reserve fixed space for ready button/message below room circles */}
            <div style={{ height: '110px', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginTop: 16 }}>
                {readyUI}
            </div>
        </div>
    );
}
