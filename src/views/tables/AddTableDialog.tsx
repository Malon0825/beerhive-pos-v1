'use client';

import React, { useState, useEffect } from 'react';
import { Table } from '@/models/entities/Table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../shared/ui/dialog';
import { Input } from '../shared/ui/input';
import { Button } from '../shared/ui/button';
import { Label } from '../shared/ui/label';
import { AlertCircle } from 'lucide-react';
import { supabase } from '@/data/supabase/client';

interface AddTableDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (tableData: {
    table_number: string;
    capacity: number;
    area?: string;
    notes?: string;
  }) => Promise<void>;
}

/**
 * AddTableDialog Component
 * Dialog for adding a new table to the restaurant
 * Features:
 * - Table number input (required)
 * - Capacity input (required)
 * - Area selection (optional)
 * - Notes field (optional)
 * - Validation before submission
 */
export default function AddTableDialog({ isOpen, onClose, onConfirm }: AddTableDialogProps) {
  const [tableNumber, setTableNumber] = useState('');
  const [capacity, setCapacity] = useState('');
  const [area, setArea] = useState('');
  const [customArea, setCustomArea] = useState('');
  const [existingAreas, setExistingAreas] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Predefined area options
   */
  const areaOptions = [
    { value: '', label: 'General (No specific area)' },
    { value: 'indoor', label: 'Indoor' },
    { value: 'outdoor', label: 'Outdoor' },
    { value: 'vip', label: 'VIP Section' },
    { value: 'bar', label: 'Bar Area' },
    { value: 'patio', label: 'Patio' },
    { value: 'terrace', label: 'Terrace' },
    { value: '__custom__', label: '+ Create New Area' },
  ];

  /**
   * Fetch existing areas from database when dialog opens
   */
  useEffect(() => {
    if (isOpen) {
      fetchExistingAreas();
    }
  }, [isOpen]);

  /**
   * Fetch all unique areas from existing tables
   */
  const fetchExistingAreas = async () => {
    try {
      const { data: tables, error } = await supabase
        .from('restaurant_tables')
        .select('area')
        .not('area', 'is', null);

      if (error) throw error;

      // Get unique areas (case-insensitive)
      const uniqueAreas = Array.from(
        new Set(
          tables
            ?.map((t) => t.area?.toLowerCase().trim())
            .filter((area): area is string => Boolean(area))
        )
      );

      setExistingAreas(uniqueAreas);
    } catch (err) {
      console.error('Error fetching areas:', err);
      // Non-critical error, continue with empty list
      setExistingAreas([]);
    }
  };

  /**
   * Validate form inputs
   */
  const validateForm = (): string | null => {
    if (!tableNumber.trim()) {
      return 'Table number is required';
    }

    if (!/^[a-zA-Z0-9\s-]+$/.test(tableNumber.trim())) {
      return 'Table number can only contain letters, numbers, spaces, and hyphens';
    }

    const capacityNum = parseInt(capacity);
    if (!capacity || isNaN(capacityNum) || capacityNum < 1) {
      return 'Capacity must be at least 1';
    }

    if (capacityNum > 50) {
      return 'Capacity cannot exceed 50 persons';
    }

    // Validate custom area if selected
    if (area === '__custom__') {
      const trimmedCustomArea = customArea.trim();
      
      if (!trimmedCustomArea) {
        return 'Custom area name is required';
      }

      if (!/^[a-zA-Z0-9\s-]+$/.test(trimmedCustomArea)) {
        return 'Area name can only contain letters, numbers, spaces, and hyphens';
      }

      // Check for duplicate (case-insensitive)
      const normalizedCustomArea = trimmedCustomArea.toLowerCase();
      if (existingAreas.includes(normalizedCustomArea)) {
        return `Area "${trimmedCustomArea}" already exists`;
      }

      // Check against predefined options (case-insensitive)
      const predefinedAreas = areaOptions
        .filter(opt => opt.value && opt.value !== '__custom__')
        .map(opt => opt.value.toLowerCase());
      
      if (predefinedAreas.includes(normalizedCustomArea)) {
        return `Area "${trimmedCustomArea}" already exists as a predefined option`;
      }
    }

    return null;
  };

  /**
   * Handle form submission
   */
  const handleSubmit = async () => {
    setError(null);

    // Validate
    const validationError = validateForm();
    if (validationError) {
      setError(validationError);
      return;
    }

    try {
      setIsSubmitting(true);

      // Determine final area value
      let finalArea: string | undefined;
      if (area === '__custom__') {
        // Use custom area (normalized to lowercase for consistency)
        finalArea = customArea.trim().toLowerCase();
      } else if (area) {
        finalArea = area;
      }

      const tableData = {
        table_number: tableNumber.trim(),
        capacity: parseInt(capacity),
        area: finalArea,
        notes: notes.trim() || undefined,
      };

      await onConfirm(tableData);

      // Success - reset form and close
      resetForm();
      onClose();
    } catch (err: any) {
      console.error('Error adding table:', err);
      setError(err.message || 'Failed to add table');
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * Reset form fields
   */
  const resetForm = () => {
    setTableNumber('');
    setCapacity('');
    setArea('');
    setCustomArea('');
    setNotes('');
    setError(null);
  };

  /**
   * Handle dialog close
   */
  const handleClose = () => {
    if (!isSubmitting) {
      resetForm();
      onClose();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add New Table</DialogTitle>
          <DialogDescription>
            Add a new table to handle high demand. Fill in the required information below.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Table Number */}
          <div className="space-y-2">
            <Label htmlFor="tableNumber" className="required">
              Table Number <span className="text-red-500">*</span>
            </Label>
            <Input
              id="tableNumber"
              type="text"
              placeholder="e.g., 1, A1, VIP 1, Table 15"
              value={tableNumber}
              onChange={(e) => setTableNumber(e.target.value)}
              disabled={isSubmitting}
              autoFocus
            />
            <p className="text-xs text-gray-500">
              Use a unique identifier (letters, numbers, spaces, and hyphens allowed)
            </p>
          </div>

          {/* Capacity */}
          <div className="space-y-2">
            <Label htmlFor="capacity">
              Capacity (Persons) <span className="text-red-500">*</span>
            </Label>
            <Input
              id="capacity"
              type="number"
              min="1"
              max="50"
              placeholder="e.g., 4"
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              disabled={isSubmitting}
            />
            <p className="text-xs text-gray-500">
              Number of persons this table can accommodate
            </p>
          </div>

          {/* Area */}
          <div className="space-y-2">
            <Label htmlFor="area">Area (Optional)</Label>
            <select
              id="area"
              value={area}
              onChange={(e) => {
                setArea(e.target.value);
                setCustomArea(''); // Reset custom area when changing selection
              }}
              disabled={isSubmitting}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {areaOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            
            {/* Custom Area Input - Shows when "Create New Area" is selected */}
            {area === '__custom__' && (
              <div className="mt-2">
                <Input
                  id="customArea"
                  type="text"
                  placeholder="Enter new area name (e.g., Garden, Rooftop)"
                  value={customArea}
                  onChange={(e) => setCustomArea(e.target.value)}
                  disabled={isSubmitting}
                  autoFocus
                />
                <p className="text-xs text-gray-500 mt-1">
                  Area name will be saved in lowercase for consistency
                </p>
              </div>
            )}
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">Notes (Optional)</Label>
            <textarea
              id="notes"
              rows={3}
              placeholder="e.g., Near window, Corner table"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={isSubmitting}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>

          {/* Error Message */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
              <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="bg-blue-600 hover:bg-blue-700"
          >
            {isSubmitting ? (
              <>
                <span className="animate-spin mr-2">⏳</span>
                Adding...
              </>
            ) : (
              'Add Table'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
