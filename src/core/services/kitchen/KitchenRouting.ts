import { KitchenOrderRepository } from '@/data/repositories/KitchenOrderRepository';
import { ProductRepository } from '@/data/repositories/ProductRepository';
import { PackageRepository } from '@/data/repositories/PackageRepository';
import { CreateKitchenOrderInput } from '@/models/entities/KitchenOrder';
import { AppError } from '@/lib/errors/AppError';

/**
 * KitchenRouting Service
 * Analyzes order items and routes them to kitchen or bartender
 */
export class KitchenRouting {
  /**
   * Route order items to appropriate stations
   * Analyzes each item and determines destination based on product category.
   * For packages, expands the package and routes each product individually.
   */
  static async routeOrder(orderId: string, orderItems: any[]): Promise<void> {
    try {
      console.log(`🍳 [KitchenRouting] Starting routing for order ${orderId}`);
      console.log(`🍳 [KitchenRouting] Order items:`, orderItems.map(i => ({
        id: i.id,
        item_name: i.item_name,
        product_id: i.product_id,
        package_id: i.package_id
      })));

      if (!orderItems || orderItems.length === 0) {
        console.warn('⚠️  [KitchenRouting] No order items to route');
        return;
      }

      const kitchenOrders: CreateKitchenOrderInput[] = [];

      // Process each order item
      for (const item of orderItems) {
        console.log(`🔍 [KitchenRouting] Processing item: ${item.item_name} (${item.id})`);
        
        // If it's a package, expand it and route each item individually
        if (item.package_id) {
          console.log(`📦 [KitchenRouting] Package detected, expanding items...`);
          const packageOrders = await this.routePackageItems(orderId, item);
          kitchenOrders.push(...packageOrders);
          console.log(`📦 [KitchenRouting] Added ${packageOrders.length} orders from package`);
        } else {
          // Regular product - route as before
          const destination = await this.determineDestination(item);
          
          console.log(`📍 [KitchenRouting] Destination for "${item.item_name}": ${destination || 'NULL'}`);
          
          if (destination) {
            kitchenOrders.push({
              order_id: orderId,
              order_item_id: item.id,
              product_name: item.item_name, // Product name for display
              destination,
              special_instructions: item.notes || undefined,
              is_urgent: false,
            });
          } else {
            console.warn(`⚠️  [KitchenRouting] No destination determined for item: ${item.item_name}`);
          }
        }
      }

      console.log(`📋 [KitchenRouting] Prepared ${kitchenOrders.length} kitchen orders`);

      // Create kitchen orders in batch
      if (kitchenOrders.length > 0) {
        console.log(`💾 [KitchenRouting] Creating kitchen orders in database...`);
        await KitchenOrderRepository.createBatch(kitchenOrders);
        console.log(`✅ [KitchenRouting] Routed ${kitchenOrders.length} items for order ${orderId}`);
      } else {
        console.warn(`⚠️  [KitchenRouting] No kitchen orders to create for order ${orderId}`);
      }
    } catch (error) {
      console.error('❌ [KitchenRouting] Error routing order to kitchen:', error);
      console.error('Stack trace:', error);
      throw error instanceof AppError ? error : new AppError('Failed to route order', 500);
    }
  }

  /**
   * Route package items to appropriate stations
   * Uses the already-loaded package data from the order item to route each product
   * to the correct station (kitchen or bartender) based on category destination.
   * 
   * This method ensures that each product in a package is routed to the correct station
   * based on the product's category, rather than sending the entire package to both stations.
   * 
   * @param orderId - The order ID
   * @param orderItem - The order item representing the package (with package data pre-loaded)
   * @returns Array of kitchen orders to be created
   */
  private static async routePackageItems(
    orderId: string,
    orderItem: any
  ): Promise<CreateKitchenOrderInput[]> {
    const kitchenOrders: CreateKitchenOrderInput[] = [];

    try {
      console.log(`📦 [KitchenRouting.routePackageItems] Processing package ${orderItem.package_id}...`);
      
      // Validate package_id exists
      if (!orderItem.package_id) {
        console.error(`❌ [KitchenRouting.routePackageItems] Order item has no package_id`);
        return kitchenOrders;
      }
      
      // Use pre-loaded package data from order item (more efficient than fetching again)
      let packageData = orderItem.package;
      
      // Fallback: If package data not pre-loaded, fetch it
      if (!packageData) {
        console.warn(`⚠️  [KitchenRouting.routePackageItems] Package data not pre-loaded, fetching...`);
        packageData = await PackageRepository.getById(orderItem.package_id);
      }
      
      if (!packageData) {
        console.error(`❌ [KitchenRouting.routePackageItems] Package not found: ${orderItem.package_id}`);
        return kitchenOrders;
      }

      console.log(`📦 [KitchenRouting.routePackageItems] Package "${packageData.name}" has ${packageData.items?.length || 0} items`);

      // If package has no items, log warning and return empty array
      if (!packageData.items || packageData.items.length === 0) {
        console.warn(`⚠️  [KitchenRouting.routePackageItems] Package "${packageData.name}" has no items configured`);
        return kitchenOrders;
      }

      // Process each item in the package
      for (const packageItem of packageData.items) {
        const product = packageItem.product;
        
        // Validate product exists
        if (!product || !product.id) {
          console.warn(`⚠️  [KitchenRouting.routePackageItems] Package item has no valid product data`);
          continue;
        }

        console.log(`🔍 [KitchenRouting.routePackageItems] Processing: ${product.name} (qty: ${packageItem.quantity})`);

        // Determine destination based on product's category
        const destination = await this.determineProductDestination(product);

        console.log(`📍 [KitchenRouting.routePackageItems] ${product.name} → ${destination || 'NO DESTINATION'}`);

        if (destination) {
          // Create kitchen order for this package item
          kitchenOrders.push({
            order_id: orderId,
            order_item_id: orderItem.id, // Reference the package order item
            product_name: product.name, // ✅ Actual product name for display
            destination,
            special_instructions: `Package: ${packageData.name} (x${packageItem.quantity})`,
            is_urgent: false,
          });
        } else {
          // Log as error since items without destination won't be prepared
          console.error(`❌ [KitchenRouting.routePackageItems] Cannot determine destination for "${product.name}" - item will not be routed`);
        }
      }

      console.log(`✅ [KitchenRouting.routePackageItems] Created ${kitchenOrders.length} kitchen orders from package "${packageData.name}"`);
      return kitchenOrders;
    } catch (error) {
      console.error('❌ [KitchenRouting.routePackageItems] Error routing package items:', error);
      console.error('Stack trace:', error);
      return kitchenOrders; // Return whatever we managed to process
    }
  }

  /**
   * Determine destination based on product
   * Used for regular order items (not packages)
   */
  private static async determineDestination(
    orderItem: any
  ): Promise<'kitchen' | 'bartender' | 'both' | null> {
    try {
      console.log(`🔍 [KitchenRouting.determineDestination] Checking item:`, {
        product_id: orderItem.product_id,
        item_name: orderItem.item_name
      });

      // If it's a product, check its category
      if (orderItem.product_id) {
        console.log(`🔍 [KitchenRouting.determineDestination] Fetching product ${orderItem.product_id}...`);
        // OrderRepository already joins category routing metadata. Reuse that
        // server-loaded row, retaining the lookup for callers with bare items.
        const loadedProduct = orderItem.product;
        const hasRoutingData = loadedProduct?.id === orderItem.product_id
          && typeof loadedProduct.name === 'string'
          && Object.prototype.hasOwnProperty.call(loadedProduct, 'category');
        const product: any = hasRoutingData
          ? loadedProduct
          : await ProductRepository.getById(orderItem.product_id);
        
        if (!product) {
          console.warn(`⚠️  [KitchenRouting.determineDestination] Product not found: ${orderItem.product_id}`);
          return null;
        }

        return await this.determineProductDestination(product);
      }

      console.warn(`⚠️  [KitchenRouting.determineDestination] No product_id found`);
      return null;
    } catch (error) {
      console.error('❌ [KitchenRouting.determineDestination] Error determining destination:', error);
      console.error('Stack trace:', error);
      // Default to kitchen if there's an error
      console.log(`⚠️  [KitchenRouting.determineDestination] Defaulting to KITCHEN due to error`);
      return 'kitchen';
    }
  }

  /**
   * Determine destination for a product based on its category
   * 
   * Uses a three-tier approach:
   * 1. Primary: Check product's category default_destination (most reliable)
   * 2. Fallback: Infer from product name using keywords (if category is missing)
   * 3. Default: Route to kitchen if all else fails
   * 
   * @param product - Product object with category information
   * @returns Destination: 'kitchen', 'bartender', or 'both'
   */
  private static async determineProductDestination(
    product: any
  ): Promise<'kitchen' | 'bartender' | 'both' | null> {
    console.log(`📦 [KitchenRouting.determineProductDestination] Product:`, {
      id: product.id,
      name: product.name,
      has_category: !!product.category,
      category_name: product.category?.name,
      default_destination: product.category?.default_destination
    });

    // Validate product has required data
    if (!product || !product.name) {
      console.error(`❌ [KitchenRouting.determineProductDestination] Invalid product data`);
      return null;
    }

    // Primary method: Use category's default destination (most reliable)
    if (product.category?.default_destination) {
      const destination = product.category.default_destination;
      console.log(`✅ [KitchenRouting.determineProductDestination] Using category "${product.category.name}" destination: ${destination}`);
      return destination as 'kitchen' | 'bartender' | 'both';
    }

    // Secondary method: Infer from product name (fallback)
    if (!product.category) {
      console.warn(`⚠️  [KitchenRouting.determineProductDestination] Product "${product.name}" has no category assigned`);
    } else {
      console.warn(`⚠️  [KitchenRouting.determineProductDestination] Category "${product.category.name}" has no default_destination set`);
    }
    
    console.log(`🔍 [KitchenRouting.determineProductDestination] Falling back to name-based inference...`);
    const inferredDestination = this.inferDestinationFromName(product.name);
    console.log(`📋 [KitchenRouting.determineProductDestination] Inferred "${product.name}" → ${inferredDestination}`);
    
    return inferredDestination;
  }

  /**
   * Infer destination from product name (fallback method)
   * 
   * This method is used as a last resort when:
   * - Product has no category assigned, OR
   * - Product's category has no default_destination configured
   * 
   * It analyzes the product name for common food/beverage keywords
   * to intelligently route the item. This ensures the system remains
   * functional even with incomplete category configuration.
   * 
   * @param productName - Name of the product to analyze
   * @returns 'kitchen' for food items, 'bartender' for beverages
   */
  private static inferDestinationFromName(productName: string): 'kitchen' | 'bartender' {
    const lowerName = productName.toLowerCase();

    // Beverage keywords (drinks, beer, cocktails, etc.)
    const beverageKeywords = [
      'beer', 'wine', 'whiskey', 'vodka', 'rum', 'gin', 'tequila',
      'cocktail', 'mojito', 'margarita', 'juice', 'soda', 'water',
      'shake', 'smoothie', 'coffee', 'tea', 'latte', 'cappuccino',
      'pale', 'pilsen', 'red horse', 'san miguel', 'bottle', 'draft'
    ];

    // Food keywords (appetizers, main dishes, Filipino food, etc.)
    const foodKeywords = [
      'sisig', 'wings', 'fries', 'burger', 'pizza', 'pasta',
      'rice', 'chicken', 'pork', 'beef', 'fish', 'seafood',
      'salad', 'soup', 'sandwich', 'pulutan', 'calamares',
      'lumpia', 'adobo', 'sinigang', 'lechon', 'barbecue', 'grilled'
    ];

    // Check for beverage keywords first
    if (beverageKeywords.some(keyword => lowerName.includes(keyword))) {
      return 'bartender';
    }

    // Check for food keywords
    if (foodKeywords.some(keyword => lowerName.includes(keyword))) {
      return 'kitchen';
    }

    // Default to kitchen (safer to send to kitchen than bartender)
    return 'kitchen';
  }

  /**
   * Route a single order item (for modifications/additions)
   */
  static async routeSingleItem(orderId: string, orderItem: any): Promise<void> {
    try {
      const destination = await this.determineDestination(orderItem);
      
      if (destination) {
        await KitchenOrderRepository.create({
          order_id: orderId,
          order_item_id: orderItem.id,
          destination,
          special_instructions: orderItem.notes || undefined,
          is_urgent: false,
        });
      }
    } catch (error) {
      console.error('Error routing single item:', error);
      throw error instanceof AppError ? error : new AppError('Failed to route item', 500);
    }
  }

  /**
   * Mark an order as urgent (priority routing)
   */
  static async markUrgent(orderId: string): Promise<void> {
    try {
      const kitchenOrders = await KitchenOrderRepository.getByOrderId(orderId);
      
      for (const ko of kitchenOrders) {
        await KitchenOrderRepository.updatePriority(ko.id, 100); // High priority
      }
    } catch (error) {
      console.error('Error marking order as urgent:', error);
      throw error instanceof AppError ? error : new AppError('Failed to mark as urgent', 500);
    }
  }
}
