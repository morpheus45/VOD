package com.pipsiflix.app.vpn;

import static org.junit.Assert.*;
import org.junit.Test;

public class VpnGateTest {
    @Test public void enforcesOnlyWhenAllOn() {
        assertTrue(VpnGate.shouldEnforce(true, true, false));   // normal
        assertFalse(VpnGate.shouldEnforce(false, true, false)); // interrupteur global OFF
        assertFalse(VpnGate.shouldEnforce(true, false, false)); // kill-switch distant OFF
        assertFalse(VpnGate.shouldEnforce(true, true, true));   // override "continuer sans VPN"
    }
}
